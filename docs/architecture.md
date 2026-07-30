# Quorum architecture

## Product boundary

Quorum is not primarily a model client. The durable product is the layer that owns:

- conversation and workspace state;
- context selection;
- privacy, network, cost, and quality policy;
- task decomposition;
- model and tool capability matching;
- recovery and fallback behavior;
- execution disclosure and audit history.

Models are replaceable execution engines behind that boundary.

## Current vertical slice

```text
apps/web
  Chat state and navigation
  Execution inspector
  SSE event consumer
         │
         ▼
apps/api
  HTTP/SSE transport
  SQLite conversation repository
  Environment-based provider registration
         │
         ▼
packages/core
  RequestCompiler
  RoutePlanner
  Orchestrator
  ModelProvider contract
  Policy and trace types
```

### Request compiler

The compiler converts a conversational request into explicit requirements:

- intent: conversation, reasoning, coding, document, vision, or research;
- required model capabilities;
- confidence and whether intent came from the current turn or conversation context;
- freshness requirement;
- normalized sensitive-data categories found in user-authored context;
- whether retained assistant context was derived from web retrieval.

The compiler combines deterministic, contextual signals with a configurable local
prompt expert. The tiny model emits only a bounded intent, confidence, and faithful
task summary; it does not rewrite the original conversation or expose private
chain-of-thought. Strong explicit signals remain authoritative on conflict, and
deterministic freshness and sensitive-data detection cannot be cleared by model
output. If the classifier is missing, malformed, slow, or unavailable, compilation
continues with the deterministic result and discloses that fallback.

The prompt expert is not an answer route. The default runtime keeps it separate from
the larger main model that owns conversational continuity and user-facing synthesis.
Answer specialists are opt-in until they pass workload-specific evaluation.

The target specialist contract keeps conversational ownership with the main model:

```text
prompt compiler -> optional specialist or tool -> main model -> user
```

A specialist returns a bounded artifact rather than a conversational response. The
main model receives that artifact together with the authoritative conversation,
resolves conflicts, and writes the public answer. This avoids handing referential
follow-ups to a stateless specialist, but adds latency and another failure boundary.
The current runtime does not yet implement this synthesis stage, so answer specialists
remain disabled by default rather than being presented as active collaborators.

For a normalized referential follow-up, the compiler can inherit the most recent
persisted effective intent from the assistant execution record. Courtesy prefixes do
not reset that state, while explicit topic resets and completed conversational turns
stop inheritance. Common programming aliases are normalized before classification.
Raw-turn scanning remains as a compatibility and recovery path for older history or
an earlier low-confidence conversational misroute.

The API reconstructs history from local storage before compilation, so
client-supplied system/tool roles cannot become model instructions.

### Route planner

The planner receives only the compiled request and registered model descriptors.
Selection is constrained before ranking:

1. remove unavailable models;
2. remove models lacking required capabilities;
3. remove cloud models forbidden by policy;
4. in Offline mode, remove every provider not running in-process;
5. for sensitive requests, remove every cloud model;
6. rank remaining models according to policy, including a bounded, deduplicated bonus
   for declared specialties that match the request. Best quality combines this bonus
   with quality rather than ignoring a specialist for a small static rating gap.

If the constrained set is empty, the planner may select only Quorum's in-process
scaffold to explain the unavailable capability. It does not call an ineligible model
or quietly weaken the policy.

### Orchestrator

The orchestrator is an async event generator. It emits:

- `plan` — the chosen route and task steps;
- `trace` — step lifecycle changes;
- `delta` — streamed response content;
- `result` — the durable assistant message;
- `error` — recoverable execution failure.

That event contract allows the API transport to change without coupling the core to
HTTP or WebSockets. A model failure can trigger another policy-safe plan only before
any response content is emitted. Repeated failures temporarily open a per-provider
circuit. Caller cancellation and request-specific validation failures do not affect
provider health. Automatic fallback never crosses from a local attempt into cloud, and
the final plan retains an append-only attempt ledger so failed cloud contact cannot be
erased by a later local result.

Detailed UI mode renders these authoritative events as an expandable in-conversation
activity rail with elapsed time, request classification, task steps, and model swaps.
Cloud contact, privacy-guard decisions, web-grounded-history guards, and terminal
failures remain visible at Standard verbosity as durable disclosures.
The final plan and coalesced traces are stored with the assistant message so each rail
survives conversation changes and application reloads. This is execution evidence,
not model-authored chain-of-thought.

### Providers

Providers implement:

```ts
interface ModelProvider {
  readonly model: ModelDescriptor;
  stream(input: ModelStreamInput): AsyncIterable<string>;
}
```

The current adapters are:

- `OpenAICompatibleProvider` for local loopback or remote cloud endpoints;
- `DemoProvider` for an offline, deterministic, in-process runnable experience.

Local adapters accept only explicit loopback URLs and do not follow redirects. A shared
scheduler serializes local inference with bounded queue length and wait time. Each
dispatch enforces its declared input/output budget, response/frame/output memory
limits, terminal stream markers, and separate first-provider-activity, idle,
validated-answer, and end-to-end timeouts. Optional reasoning settings are retried
without the extension only if a compatible server identifies that exact field as
unsupported. Cloud endpoints require HTTPS.

On process startup, Quorum discovers local models with bounded retry/backoff, then
warms the local classifier followed by the default general model. Ollama's native
keep-alive route is used when available, with a bounded OpenAI-compatible fallback
for other loopback runtimes. While warmup owns the local scheduler, the API returns a
recoverable preparing response instead of accepting work that cannot run. Runtime
status reads and chat dispatch also re-probe missing configured models, so a model
server that starts later can join without restarting Quorum.

For model generation, Quorum discards structured private-thinking fields. Native
Ollama requests use its JSON-schema `format` field and accept exactly one visible
`answer` string. Compatibility JSON and SSE routes use a reserved final-answer
envelope because that transport does not guarantee the same schema feature. Both
paths buffer the bounded response and release it only after validating the complete
answer and the transport's terminal marker. Non-whitespace text outside a compatibility
envelope, nested or repeated reserved tags, empty or visually blank content, post-
terminal records, and incomplete output are rejected before user-visible content
begins. Unsafe output is not a provider-health failure and can trigger a policy-safe
fallback.

This is a transport and formatting boundary, not a semantic proof of what the model
placed in its answer channel. Structured reasoning fields are withheld, but text that
the model itself puts inside a valid structured answer field or compatibility envelope
is displayed. The interface makes that distinction explicit rather than promising that
arbitrary model-authored text can be classified as private scratch work with certainty.

Validated model answers are currently released as a complete bounded response rather
than token by token. The event transport still streams request-analysis, planning, and
execution state, and the chat renders a content-independent generation status while
validation is pending.

The model descriptor declares location, role, transport, capabilities, optional
specialties, executable context budget, inference settings, and a provisional quality
rating. Capabilities are hard eligibility requirements; specialties influence ranking
only after a model is eligible. Benchmarks and user preferences should eventually
replace the static quality rating and specialty bonus.

### Persistence

Conversation and message records live in `var/quorum.db`. SQLite uses WAL mode and
foreign keys. This is intentionally local and single-node for the first slice.

Per-response plans and coalesced traces are persisted with assistant messages. A later
append-only audit ledger should additionally store disclosures, tool invocations,
token counts, cost, detailed timings, and redaction decisions separately from
conversation content.

## Target capability graph

```text
                           ┌─ local chat/reasoning model
                           ├─ local coding model
Request ─ Compiler ─ Plan ─├─ OCR / document parser
                           ├─ vision model
                           ├─ retrieval + reranker
                           ├─ sandboxed tools
                           ├─ speech pipeline
                           └─ permitted cloud fallback
```

Each node should declare:

- input and output schemas;
- capability tags;
- execution location and transport;
- data classifications it accepts;
- resource requirements;
- health and confidence signals;
- estimated latency and cost;
- permissions and network domains;
- cancellation and recovery behavior.

The planner can then construct task graphs from capabilities rather than naming
specific vendors or models.

## Planned boundaries

### Desktop runtime

A proposed Tauri 2 shell will supervise the existing UI and API rather than absorb
their responsibilities. It can bundle and start the Quorum API as a platform-specific
sidecar, discover Ollama, and manage optional native or containerized services.
Container support remains an optional integration: on Windows, a Linux container still
requires Docker Desktop, Podman, or another runtime backed by WSL 2 or Hyper-V.

See [ADR 0001](./decisions/0001-desktop-shell-and-service-supervision.md).

### Attachment pipeline

Attachments should enter a local content-addressed store before processing. The API
should create an immutable attachment record, detect media type, and dispatch to
capability-specific preprocessors. Raw files must not be included in cloud requests
unless the active policy and a disclosure both allow it.

```text
upload
  ↓
hash + local record
  ↓
type detection
  ├─ PDF → text/layout extraction → OCR fallback
  ├─ image → metadata stripping → vision preprocessing
  ├─ audio → local transcription
  └─ code → language-aware chunking
```

### Tool runtime

Tools should be packages with a signed or locally trusted manifest. A manifest must
state permissions, schemas, network access, filesystem scope, and whether an action is
read-only or mutating. The orchestrator should never infer permission from a model's
tool call.

### Retrieval and memory

Keep three concerns separate:

- conversation history: ordered messages in the current thread;
- workspace knowledge: user-selected files and indexed artifacts;
- personal memory: durable user facts with explicit inspect/edit/delete controls.

Retrieval results should retain source identity so synthesis can cite exactly which
local or remote material was used.

### Cloud disclosure

Before the first cloud transmission in a request, the execution plan should expose:

- provider and model;
- why local execution was insufficient;
- the exact context categories leaving the device;
- any redaction or local preprocessing already applied;
- estimated cost.

The resulting decision belongs in a local usage ledger.

## Security invariants

- A policy may be tightened automatically, never weakened silently.
- Sensitive classification excludes cloud routes even in Best quality mode.
- Web-grounded assistant history excludes cloud routes on later turns.
- Offline mode excludes loopback endpoints as well as remote endpoints.
- A provider is registered only when its configured model is discoverable.
- A local provider URL must be explicit loopback and redirects are forbidden.
- A cloud provider URL must use HTTPS and redirects are forbidden.
- Cloud providers are absent when credentials are absent.
- Conversation storage is local by default.
- Stored history and server-generated message identities, not client-submitted roles,
  timestamps, or IDs, are authoritative model context.
- Tool authorization must be evaluated outside model output.
- Execution disclosure is derived from the actual plan, not decorative UI state.
- The current loopback HTTP API is not an authorization boundary for other local
  non-browser processes; the desktop sidecar must add a per-launch secret.

These invariants should remain covered by tests as the capability graph grows.
