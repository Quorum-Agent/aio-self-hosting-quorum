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
- Keyless policy-controlled web search with live Auto/provider settings
- DuckDuckGo, SearXNG, Exa, Perplexity, Tavily, Brave, and Firecrawl adapters
- Source citations and durable search/provider-fallback disclosure
- Loopback-only local endpoints with redirects disabled
- Append-only execution attempts so failed cloud contact remains disclosed
- A deterministic in-process responder when no configured model is available
- Production build served by the API process
- Startup warmup for the prompt expert and default general model
- Native Ollama generation that keeps private thinking separate from visible answers
- Opt-in managed llama.cpp sidecar with interchangeable, verified GGUF entries

Attachment, microphone, vision, project memory, and general-purpose tool
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

Vite's generic `--host` hint does not safely expose the complete application because
Quorum's unauthenticated API is deliberately loopback-only. For development on a
trusted LAN, use the explicit authenticated gateway:

```powershell
npm run dev:network
```

Quorum generates and prints an easy-to-type `XXXX-XXXX` pairing code for that launch;
sign in with username `quorum`. The generated code is the recommended path — it is
random and lasts only for that launch. To reuse one password instead, invent a phrase
of at least 24 characters and add it to the ignored `.env` file:

```dotenv
QUORUM_DEV_NETWORK_PASSWORD=<invent-your-own-phrase-here>
```

Choose your own value rather than copying one from documentation: this gateway has no
lockout, so a password that appears in a public repository is the first one an
unwelcome guest on the LAN will try.

Vite will print the available network URLs. The API remains bound to loopback and is
reached through the authenticated Vite proxy. This development gateway uses plain
HTTP; use a VPN or encrypted tunnel outside a trusted LAN. `npm run dev -- --host` is
intentionally rejected with guidance to this command.

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

### Managed llama.cpp runtime spike

Quorum can now supervise an upstream `llama-server` process instead of requiring an
already-running model service. The runtime executable and model files are deliberately
not stored in this repository or bundled together. Copy
`config/managed-models.example.json` to `config/managed-models.local.json`, point its
stable logical IDs at local GGUF files, and configure:

```dotenv
QUORUM_MANAGED_LLAMA_SERVER=C:/Quorum/runtime/llama-server.exe
QUORUM_MANAGED_LLAMA_MODELS=./config/managed-models.local.json
QUORUM_LOCAL_PROMPT_MODEL=quorum-prompt
QUORUM_LOCAL_MODEL=quorum-main
```

On startup Quorum validates each configured file (including its SHA-256 when supplied),
generates an authenticated llama.cpp router preset, waits for the requested models, and then uses its existing
OpenAI-compatible provider. The browser never receives the runtime credential. Ollama
and LM Studio remain valid optional endpoints when the managed settings are absent.

This is the process and model-slot contract validated by the Windows spike, not the
final desktop packaging. The current Ollama Qwen 3.5 blobs did not load in upstream
llama.cpp `b10192`, so model selection must verify the exact GGUF artifact against the
pinned runtime. See the
[managed-runtime evaluation](docs/evaluations/managed-llama-runtime-2026-07-30.md).

### Optional cloud fallback

Set these values in `.env`:

```dotenv
QUORUM_CLOUD_BASE_URL=https://api.openai.com/v1
QUORUM_CLOUD_MODEL=gpt-4.1-mini
QUORUM_CLOUD_API_KEY=your-key
QUORUM_CLOUD_CONTEXT_WINDOW=128000
QUORUM_CLOUD_QUALITY_RATING=80
```

The cloud provider is not registered when the key is blank. Private and Offline modes
never select a cloud model. Requests detected as sensitive never use cloud; when no
capable local model exists, Quorum reports the failure instead of fabricating a
scaffold answer. Set the context window and quality rating to match the provider you
actually configure; routing does not assume that every cloud model is equally capable.

### Web search

Web search is automatic for requests that need current information or external
sources. It is not used for ordinary explanation or analysis. Quorum retrieves a
small bounded source set, passes it to a local model as explicitly framed untrusted
evidence, and renders its source links from structured execution data rather than
concatenating untrusted titles into the answer. The provider and sources remain in
the durable execution record. Retrieved web data and later turns derived from it are
kept away from cloud models.

Search is enabled out of the box. With no configuration, Auto mode uses keyless
DuckDuckGo. Configure the master toggle, provider, result count, SearXNG URL, and
optional provider keys from **Web search settings** in the sidebar. Changes apply
to the next request without restarting Quorum.

Auto mode uses configured providers in this order and falls back visibly when a
provider fails:

```text
Exa → Perplexity → Tavily → Brave → Firecrawl → SearXNG → DuckDuckGo
```

Non-secret settings are stored in the local `quorum.db`. Keys entered in the UI stay
in server memory for the current run and are never written to SQLite or returned to
the browser. Use environment variables when credentials must survive a restart:

```dotenv
QUORUM_WEB_SEARCH_ENABLED=true
QUORUM_WEB_SEARCH_PROVIDER=auto
QUORUM_WEB_SEARCH_RESULT_LIMIT=5

# Optional provider configuration used by Auto:
QUORUM_SEARXNG_BASE_URL=http://127.0.0.1:8080

QUORUM_EXA_SEARCH_API_KEY=your-key
QUORUM_PERPLEXITY_SEARCH_API_KEY=your-key
QUORUM_TAVILY_SEARCH_API_KEY=your-key
QUORUM_BRAVE_SEARCH_API_KEY=your-search-key
QUORUM_FIRECRAWL_SEARCH_API_KEY=your-key
```

Set `QUORUM_WEB_SEARCH_PROVIDER` to a provider ID instead of `auto` to require
that provider and disable automatic provider fallback. Setting
`QUORUM_WEB_SEARCH_ENABLED=false` is an operator kill switch: saved UI settings cannot
turn search back on.

SearXNG accepts explicit loopback HTTP or HTTPS URLs; remote instances are rejected
to keep the configurable endpoint out of Quorum's server-side request boundary.
Quorum does not rotate through public instances. Private and Offline modes never
search, and requests detected as sensitive never search. Each logical search has one
eight-second deadline, does not follow redirects, allows at most two concurrent and
30 per minute, and feeds only bounded HTTPS results that pass lexical safety
filtering to a local model. Link destinations remain explicitly unverified because
Quorum does not resolve or navigate them. Sensitive results are
discarded before model routing, and persisted execution records store source titles
and URLs rather than source snippets.

If an earlier development build saved provider keys in `quorum.db`, this version
purges the legacy setting with SQLite secure deletion, WAL truncation, and `VACUUM`.
Rotate those old keys once anyway, because Quorum cannot sanitize external backups.

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
| `PATCH` | `/api/conversations/:id` | Rename a conversation |
| `DELETE` | `/api/conversations/:id` | Delete a conversation and its messages |
| `GET` | `/api/conversations/:id/messages` | Conversation history |
| `GET` | `/api/conversations/:id/export` | Export a conversation as JSON |
| `POST` | `/api/chat` | Stream plan, trace, delta, result, and error events |

The development API binds to loopback and rejects non-loopback Host headers, but it
does not yet authenticate local clients. Browser cross-origin access is blocked by
the absence of CORS, while another non-browser process running as the same user can
read the API. The desktop-shell design adds a per-launch authenticated sidecar
channel; do not treat loopback binding alone as an authorization boundary.

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
