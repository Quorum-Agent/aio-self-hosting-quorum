# Quorum

Quorum is a local-first conversational computing platform. It presents one coherent
assistant while an inspectable orchestration layer decides which models, tools, and
data are allowed to participate in each request.

The governing rule is:

> Local by default. Cloud by exception. User policy decides.

This repository contains the first vertical slice of that idea. It is runnable without
a model server, persists conversations locally, streams orchestration events, and can
use an OpenAI-compatible local or cloud model when configured.

## What works today

- Chat interface with persistent local conversations
- Four enforced UI policies: Private, Balanced, Best quality, and Offline
- Contextual request compilation into intents, confidence, and required capabilities
- Persisted effective-intent handoff across referential conversation turns
- A local 2B prompt expert with deterministic software-taxonomy safeguards
- Specialty-aware model routing with fail-closed handling for sensitive content
- A live execution inspector showing steps, route, model, and cloud usage
- Persistent per-response Detailed activity with timing, classification, steps, and swaps
- Server-sent event streaming from orchestrator to UI
- Local SQLite storage under `./var`
- OpenAI-compatible model adapter
- Automatic discovery of configured local models and experts
- Role-aware ready, degraded, and unavailable runtime status
- Serialized local inference, bounded execution time, circuit breaking, and safe fallback
- Automatic policy-controlled web search through local SearXNG or Brave Search
- Source citations and durable search-transmission disclosure, including failed searches
- Loopback-only local endpoints with redirects disabled
- Append-only execution attempts so failed cloud contact remains disclosed
- A deterministic in-process responder when no configured model is available
- Production build served by the API process
- Startup warmup for the prompt expert and default general model
- Native Ollama generation that keeps private thinking separate from visible answers

Attachment, microphone, settings, vision, project memory, and general-purpose tool
execution are planned but are not exposed as controls until they are wired. See
[Roadmap](#roadmap) for the intended order.

## Quick start

Requirements:

- Node.js 22.5 or newer
- npm 10 or newer

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on
`http://127.0.0.1:8787`.

Quorum remains usable if no model is installed: it selects the in-process scaffold
responder and exposes that decision in the execution panel.

### Connect Ollama

The default configuration expects Ollama's OpenAI-compatible endpoint, a
`qwen3.5:9b` main model, and a `qwen3.5:2b` prompt expert:

```bash
ollama pull qwen3.5:9b
ollama pull qwen3.5:2b
```

The prompt expert extracts a faithful task summary and intent before routing. Strong
deterministic signals, a maintained software vocabulary, and sensitive-data detection
remain authoritative if the model conflicts or fails. It is not registered as an
answer model. The main model owns conversation continuity and all user-facing answers
unless an explicitly configured specialist has passed evaluation for the user's
workload. Best quality still accounts for model quality, and an opt-in matching
specialist can overcome a small static quality gap.

At startup, Quorum warms the prompt expert first and the default general model last,
keeping both alive through Ollama for 30 minutes. This moves the initial model-load
latency to `npm run dev` instead of the first chat turn. Set
`QUORUM_LOCAL_WARMUP=false` to disable this behavior.

Restart Quorum after installing models. To change any model role:

```bash
copy .env.example .env
```

Then change `QUORUM_LOCAL_MODEL` or `QUORUM_LOCAL_PROMPT_MODEL` in `.env`. Optional
`QUORUM_LOCAL_CODING_MODEL` and `QUORUM_LOCAL_REASONING_MODEL` values add answer
specialists; leaving them unset keeps user-facing generation on the main brain. Quorum only
registers a role after the configured model appears in the endpoint's `/models`
response. Runtime status distinguishes discovery from startup warmup, and execution
failures feed the runtime circuit breaker.

Quorum enforces a conservative 16,384-token dispatch budget for the default answer
model and a 4,096-token budget for the prompt expert.
Override it only when the endpoint is configured to execute a different budget:

```dotenv
QUORUM_LOCAL_CONTEXT_WINDOW=16384
QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW=4096
```

### Optional cloud fallback

Set these values in `.env`:

```dotenv
QUORUM_CLOUD_BASE_URL=https://api.openai.com/v1
QUORUM_CLOUD_MODEL=gpt-4.1-mini
QUORUM_CLOUD_API_KEY=your-key
```

The cloud provider is not registered when the key is blank. Private and Offline modes
never select a cloud model. Requests detected as sensitive never use cloud; when no
capable local model exists, the in-process scaffold reports the limitation.

### Optional web search

Web search is automatic for requests that need current information or external
sources. It is not used for ordinary explanation or analysis. Quorum retrieves a
small bounded source set, passes it to a local model as lower-privilege untrusted
evidence, appends source links to the answer, and records the provider and sources
in the execution inspector. Retrieved web data is never forwarded to a cloud model.

For a local-first setup, run a SearXNG instance on this machine, enable JSON output,
and configure:

```dotenv
QUORUM_WEB_SEARCH_PROVIDER=searxng
QUORUM_SEARXNG_BASE_URL=http://127.0.0.1:8080
```

The SearXNG endpoint is restricted to an explicit loopback address. SearXNG is local,
but its upstream search requests can still disclose the query; Quorum reports that
in the inspector.

Alternatively, configure Brave Search:

```dotenv
QUORUM_WEB_SEARCH_PROVIDER=brave
QUORUM_BRAVE_SEARCH_API_KEY=your-search-key
```

No search provider is registered when these values are absent. Private and Offline
modes never search. Requests detected as sensitive never search. Search calls time
out after eight seconds, do not follow redirects, allow at most two concurrent and
30 per minute, and feed only bounded, validated public HTTPS results to a local model.
Sensitive results are discarded before model routing, and persisted execution records
store source titles and URLs rather than source snippets.

## Architecture

```text
React chat + execution inspector
              │
              │ SSE / JSON
              ▼
       Fastify local API
              │
   ┌──────────┴──────────┐
   │                     │
SQLite conversation   Orchestrator
store                    │
              ┌──────────┴──────────┐
              │                     │
       Request compiler       Route planner
                                    │
                  ┌──────┴──────┬─────────────┐
                  │             │             │
           Local providers  Web search  Cloud providers
```

The core package has no dependency on Fastify, React, Ollama, or a cloud vendor.
Providers expose a small streaming interface and can be replaced independently of
policy, planning, or conversation state.

The request path is:

```text
conversation + prompt + policy
              ↓
intent and capability compilation
              ↓
policy-constrained model selection
              ↓
inspectable task plan
              ↓
streamed execution
              ↓
local persistence
```

More detail is in [docs/architecture.md](docs/architecture.md).

## Workspace

| Workspace | Responsibility |
| --- | --- |
| `apps/web` | React/Vite chat application and execution inspector |
| `apps/api` | Fastify API, SQLite persistence, provider configuration |
| `packages/core` | Domain types, request compiler, policies, routing, orchestration |

Useful commands:

```bash
npm run dev        # API and web development servers
npm run typecheck  # strict TypeScript across all workspaces
npm test           # routing and persistence tests
npm run build      # production bundles
npm run check      # typecheck, test, and build
npm start          # serve built UI and API on port 8787
npm run evaluate:prompt -w @quorum/api -- qwen3.5:2b
                     # benchmark production intent classification and merging
```

## API surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process and configured-model readiness |
| `GET` | `/api/runtime` | Policies, registered models, and runtime state |
| `GET` | `/api/conversations` | Locally persisted conversations |
| `POST` | `/api/conversations` | Create a conversation |
| `GET` | `/api/conversations/:id/messages` | Conversation history |
| `POST` | `/api/chat` | Stream plan, trace, delta, result, and error events |

## Policy semantics

| Mode | Current routing behavior |
| --- | --- |
| Private | Local models only |
| Balanced | Prefer the strongest suitable local model; search when freshness requires it |
| Best quality | Select the strongest eligible route using quality plus matched specialization |
| Offline | In-process providers only; no loopback or remote model calls |

The core policy type reserves Cost controlled for the usage-ledger milestone, but the
API and UI do not expose it until a real cap can be enforced.

## Roadmap

The next useful milestones are:

1. Provider manager: install, probe, benchmark, and configure local models from the UI.
2. Attachment pipeline: local file storage, PDF parsing, OCR, and image preprocessing.
3. Tool runtime: permission manifests, sandboxed execution, and inspectable tool calls.
4. Retrieval and memory: project workspaces, embeddings, citations, and memory controls.
5. Cloud consent and usage ledger: disclosure before transmission, budgets, and audit history.
6. Voice and multimodal experts: speech-to-text, text-to-speech, vision, and reranking.

The architectural boundaries for these milestones are described in
[docs/architecture.md](docs/architecture.md).
