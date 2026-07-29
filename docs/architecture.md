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

- intent: conversation, coding, document, vision, or research;
- required model capabilities;
- freshness requirement;
- sensitive-data signal.

The current classifier is deterministic and intentionally small. It is a boundary,
not the final implementation. A later compiler can combine rules, a local classifier,
attachment metadata, workspace policy, and user overrides without changing providers.

### Route planner

The planner receives only the compiled request and registered model descriptors.
Selection is constrained before ranking:

1. remove unavailable models;
2. remove models lacking required capabilities;
3. remove cloud models forbidden by policy;
4. in Offline mode, remove every provider not running in-process;
5. for sensitive requests, remove every cloud model;
6. rank remaining models according to policy.

If the constrained set is empty, planning fails. It does not quietly weaken the policy.

### Orchestrator

The orchestrator is an async event generator. It emits:

- `plan` — the chosen route and task steps;
- `trace` — step lifecycle changes;
- `delta` — streamed response content;
- `result` — the durable assistant message;
- `error` — recoverable execution failure.

That event contract allows the API transport to change without coupling the core to
HTTP or WebSockets.

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

The model descriptor declares location, transport, capabilities, context window, and a
provisional quality rating. Benchmarks and user preferences should eventually replace
the static quality rating.

### Persistence

Conversation and message records live in `var/quorum.db`. SQLite uses WAL mode and
foreign keys. This is intentionally local and single-node for the first slice.

Execution traces are currently streamed but not persisted. A later audit ledger should
store plans, disclosures, tool invocations, token counts, cost, timings, and redaction
decisions separately from conversation content.

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
- Offline mode excludes loopback endpoints as well as remote endpoints.
- A provider is registered only when its configured model is discoverable.
- Cloud providers are absent when credentials are absent.
- Conversation storage is local by default.
- Tool authorization must be evaluated outside model output.
- Execution disclosure is derived from the actual plan, not decorative UI state.

These invariants should remain covered by tests as the capability graph grows.
