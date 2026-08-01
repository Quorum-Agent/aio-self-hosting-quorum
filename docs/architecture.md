# Quorum architecture

## What Quorum is for

Run a set of specialist models **you choose**, on hardware **you control**, and get
what a single large generalist would give you — for less memory. The thing Quorum
replaces is loading one 30B mixture-of-experts to cover coding, documents, and
conversation at once.

**That goal is capability ownership, not data privacy.** Privacy falls out of running
locally; it is not the thing being bought. The distinction is load-bearing and is
already encoded in the type system: the `remote` tier exists because a user who
declines vendor APIs on principle may still rent a GPU and run their own weights on
it under their own configuration.

Read that paragraph before concluding that some behaviour "violates" a mode on privacy
grounds. Policy ceilings constrain **where computation happens** and **how far a tool
may reach within a request**. They are not a promise that no byte ever leaves — see
*Execution location tiers* below, and note that `offline`'s description means every
computation runs on this machine, not that the application never opens a socket.

## Product boundary

Quorum is not primarily a model client. The durable product is the layer that owns:

- conversation and workspace state;
- context selection;
- execution-location, tool-reach, cost, and quality policy — *not* "privacy
  policy"; see the section above, and note that the ceilings govern where
  computation happens rather than promising anything about bytes;
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
3. remove every model whose reach exceeds the policy's `inferenceCeiling`
   (`route-planner.ts` — one tier comparison, naming no policy). **Offline is not a
   step of its own**; it is this step with a ceiling of `device`. An earlier version
   of this list described it separately, which contradicted *Execution location
   tiers* below;
4. for sensitive requests, keep only models whose location is `local`. This is a
   **floor on the data, not the policy's ceiling**, so it also excludes a LAN peer
   and rented hardware — not merely vendor APIs. An earlier version said "remove
   every cloud model", which would have let confidential content reach a `network`
   peer;
5. rank remaining models according to policy, including a bounded, deduplicated bonus
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
provider health. Automatic fallback never selects a tier further
out than the attempt that just failed, and the final plan retains an append-only attempt
ledger so failed off-device contact cannot be erased by a later local result.

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

- `OpenAICompatibleProvider` for every off-`device` tier — loopback, a LAN peer, a
  rented box, or a vendor API. It selects a URL validator from the declared location
  rather than assuming two cases;
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
`answer` string. Compatibility routes now send `response_format` **as well as** the
reserved final-answer envelope, and parse the response with both — JSON first, then
envelope extraction of the same body. One response, two parsers, no extra round trip.
That degrades correctly against a server which accepted the schema and then ignored
it, which is a documented llama.cpp failure mode that returns HTTP 200. Measured
against a real model, the envelope alone produced a usable answer in 3 of 6 cases and
`response_format` produced 6 of 6. Both
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

A Tauri 2 shell will supervise the existing UI and API rather than absorb their
responsibilities. It will bundle a pinned llama.cpp runtime and the Quorum API as
platform-specific sidecars while keeping model weights separately downloaded and
interchangeable through logical model slots. Ollama, LM Studio, and other compatible
endpoints remain optional integrations rather than prerequisites.
Container support remains an optional integration: on Windows, a Linux container still
requires Docker Desktop, Podman, or another runtime backed by WSL 2 or Hyper-V.

See [ADR 0001](./decisions/0001-desktop-shell-and-service-supervision.md).

### Spend guardrail

Token usage is now captured from both transports (`TokenUsage`, with a `measured` flag
separating reported counts from estimates). Enforcement is not built, and the shape it
should take is decided:

**Exhausting a budget stops and asks.** It does not silently degrade to a local model, and
it does not fail the request. The user is notified and chooses: answer locally, or
authorise further spend. The model is a permission prompt rather than a policy tightening.

That distinction has an architectural cost worth stating before anyone starts. The
orchestrator is a one-way async event generator — it emits `plan`, `trace`, `delta`,
`result`, `error` and never awaits a reply. A mid-request decision point needs either a
bidirectional channel or a terminal "budget exhausted, choose and resend" state that
carries enough context to resume. **This is an interaction design, not a planner change**,
and the planner-level version (quietly excluding cloud models once a budget is spent) is
explicitly *not* what was asked for.

Unmeasured spend is charged as a conservative estimate and labelled as an estimate.
Treating an unreporting provider as having spent nothing would put the hole in a spend cap
at exactly the backend that stays quiet.

**The guardrail fires at 95% of the stated budget, not at 100%**, because stopping early
is not free. A relay through a 9–12B local generalist is materially weaker than the cloud
model it replaced — the fallback costs answer quality, not just convenience — so the
design should run as close to the limit as it can rather than leaving headroom out of
caution.

**That threshold constrains which estimate it reads, and the two rules pull opposite
ways.** Spend can be measured three ways and they disagree: the provider's per-call
`usage.cost`, the account ledger, and tokens multiplied by published list price.

**Measured, and it is simpler than an earlier draft of this section claimed.** Five calls
to one model: the provider's reported `usage.cost` totalled $0.005640, tokens priced from
the published rate totalled $0.005640, and the account ledger moved by exactly $0.005640.
Three-way agreement to the cent.

So **`usage.cost` is authoritative** and the guardrail should simply read it. Two earlier
claims here were wrong and are corrected rather than quietly dropped:

- *"Every measure under-reports, so take the largest."* False. The billed figure does not
  under-report; it matched the ledger exactly. The rule was built on a premise that a
  measurement disproved.
- *"The computed figure runs 14% above what was charged, because requests route to the
  cheapest upstream."* Wrong twice over — the 14% was against the self-reported figure, no
  reading of the actual charge existed at the time, and the mechanism was invented.

The real finding is that **a price table cannot cost these calls at all.** An aggregator
routes one model id across hosts at different rates — `deepseek-r1` returned via Novita at
$0.70/M on one run and Azure at $1.48/M on the next — and several endpoints share a
display name, so a `model|host` key does not identify one. `gemini-3.1-pro` spans six hosts
from $1.00 to $3.60 with the listed price mid-range, so the error has no consistent
direction. An attempt to fix this by pricing per-host made it worse (14% → 44%), because
`grok-4.5` has four endpoints all named "xAI" spanning $2.00–$4.00.

**The ledger settles in about three minutes** — measured, unchanged at +1m and +2m, correct
from +3m onward. A reading taken seconds after a call returns a partial figure that looks
like a discount. Anything comparing against it must wait, and five minutes is the safe
margin.

Which leaves a straightforward design:

- **The threshold reads `usage.cost`**, at 95% of budget. No estimator tension, because the
  billed figure is accurate.
- **The ledger is a slow audit**, not an input to a live decision.
- **A computed figure is a disagreement detector at best.** It should never override the
  billed number.
- **The one real gap is a call that returns no cost field at all.** That is when the billed
  total is genuinely short, and it is the case `TokenUsage.measured` exists to mark.

- **A hard cap, if one is ever added, is the opposite case** and should read the largest
  available figure. Overspending is not recoverable; stopping early is.

Stated plainly because the naive combination — conservative estimator plus an aggressive
threshold — produces neither safety nor efficiency, and looks correct from either side
alone.

### Saved-model staleness

A saved slot assignment can outlive the artifact it names. The availability half of that
question is **already answered**: `LocalRuntimeStatus.roles[]` carries `configuredModel`
and `available` per role, so the runtime already knows which configured models are missing.
A second staleness check over the settings store would be a rival mechanism for one fact.

What the settings store uniquely knows is **provenance** — whether a value was saved
through the interface or came from the environment (`slotSource`). That decides whether the
interface can offer a fix at all: a slot pinned by an environment variable will not change
when a setting is saved, and offering that edit would leave the operator looking at a value
the application is not using. Any surfacing of a missing model should read availability
from the runtime and provenance from the store, never availability from both.

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

## Execution location tiers

Execution locations are **ordered**, not a local/cloud binary:

```
device  →  local  →  network  →  remote  →  web  →  cloud
in-proc    loopback   your LAN    a box you   public   a vendor's
                                  rent        internet  API
```

`local` means *does not leave your device*. `web` is the public internet reached by a
**tool**, and is deliberately not `cloud`: `cloud` means a vendor's inference API, which
receives the whole conversation under that vendor's retention terms, while a search
provider receives a query string. It sits below `cloud` because less travels, which lets
a policy say "tools may reach the internet, models may not" — a statement the earlier
vocabulary could not make. A model is never `web`; the type excludes it.

`remote` and `cloud` differ in who controls the stack rather than in network exposure — self-hosted inference on
rented hardware runs your weights under your configuration; a vendor API does
not — so a user who declines vendor APIs on principle can still permit rented
GPU.

Policies express what they permit as a **ceiling** within that order, on two
independent axes: `inferenceCeiling` for where a model may run, `toolCeiling`
for where retrieval may reach. They are separate because a search engine's
reachability is not a model's. `preferLocal` remains a sort preference and
grants nothing.

Two consequences worth stating, because both used to be special cases:

- **Offline is not special-cased.** It declares `inferenceCeiling: "device"`,
  and an in-process model is treated as `device` because it opens no socket.
  The invariant below falls out of the same comparison every other policy uses.
- **Disclosure is derived from the plan's reach**, the maximum tier across all
  steps, not from the selected model's location. A stage running further out
  than the model that was chosen — a cloud hub behind a local spoke — cannot go
  unreported.

Whether execution leaves the device is answered in exactly one place,
`leavesDevice()`. It was previously written inline as `location === "cloud"` at
five independent sites, each of which would silently answer "no" for any tier
added later.

## Security invariants

- A policy may be tightened automatically, never weakened silently.
- Sensitive classification stays on the device even in Best quality mode. This
  is a floor on data sensitivity, not a policy ceiling: confidential content
  does not reach a LAN peer merely because the policy would permit one.
- Web-grounded assistant history excludes off-device routes on later turns, and
  may not egress at all on the turn that retrieved it.
- Offline mode excludes loopback endpoints as well as remote endpoints.
- A model may not claim a nearer tier than its location. Where `transport` and
  `location` disagree, the further of the two governs.
- Automatic fallback never selects a tier further out than the attempt that
  just failed.
- A provider is registered only when its configured model is discoverable.
- A local provider URL must be explicit loopback and redirects are forbidden.
- A network provider URL must address a genuinely private host; plain HTTP is
  permitted there and nowhere further out.
- A remote or cloud provider URL must use HTTPS and redirects are forbidden.
- Cloud providers are absent when credentials are absent.
- Conversation storage is local by default.
- Stored history and server-generated message identities, not client-submitted roles,
  timestamps, or IDs, are authoritative model context.
- Tool authorization must be evaluated outside model output.
- Execution disclosure is derived from the actual plan, not decorative UI state.
- The current loopback HTTP API is not an authorization boundary for other local
  non-browser processes; the desktop sidecar must add a per-launch secret.

These invariants should remain covered by tests as the capability graph grows.
