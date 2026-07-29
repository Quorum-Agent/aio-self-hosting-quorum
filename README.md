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
- A local 0.6B prompt expert with deterministic classification safeguards
- Specialty-aware model routing with fail-closed handling for sensitive content
- A live execution inspector showing steps, route, model, and cloud usage
- Detailed-mode in-conversation activity with timing, classification, steps, and swaps
- Server-sent event streaming from orchestrator to UI
- Local SQLite storage under `./var`
- OpenAI-compatible model adapter
- Automatic discovery of configured local models and experts
- Role-aware ready, degraded, and unavailable runtime status
- Serialized local inference, bounded execution time, circuit breaking, and safe fallback
- Loopback-only local endpoints with redirects disabled
- Append-only execution attempts so failed cloud contact remains disclosed
- A deterministic in-process responder when no configured model is available
- Production build served by the API process
- Startup warmup for the prompt expert and default general model
- Native Ollama generation that keeps private thinking separate from visible answers

Attachment, microphone, settings, vision, retrieval, tools, memory, and web execution
are planned but are not exposed as controls until they are wired. See [Roadmap](#roadmap)
for the intended order.

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

The default configuration expects Ollama's OpenAI-compatible endpoint, a `qwen3:4b`
general model, and a small `qwen3:0.6b` prompt-analysis expert:

```bash
ollama pull qwen3:4b
ollama pull qwen3:0.6b
```

Two optional text experts can be installed before Quorum starts:

```bash
ollama pull qwen2.5-coder:1.5b
ollama pull qwen3.5:2b
```

The prompt expert extracts a faithful task summary and intent before routing. Strong
deterministic signals and sensitive-data detection remain authoritative if the tiny
model conflicts or fails. Coding work routes to the coding expert, math and logic work
to the reasoning expert, and ordinary conversation to the general model. Best quality
still accounts for model quality, but a matching specialist can overcome a small
static quality gap.

At startup, Quorum warms the prompt expert first and the default general model last,
keeping both alive through Ollama for 30 minutes. This moves the initial model-load
latency to `npm run dev` instead of the first chat turn. Set
`QUORUM_LOCAL_WARMUP=false` to disable this behavior.

Restart Quorum after installing models. To change any model role:

```bash
copy .env.example .env
```

Then change `QUORUM_LOCAL_MODEL`, `QUORUM_LOCAL_PROMPT_MODEL`,
`QUORUM_LOCAL_CODING_MODEL`, or `QUORUM_LOCAL_REASONING_MODEL` in `.env`. Quorum only
registers a role after the configured model appears in the endpoint's `/models`
response. Runtime status distinguishes discovery from startup warmup, and execution
failures feed the runtime circuit breaker.

Quorum enforces a conservative 16,384-token dispatch budget for each default role.
Override it only when the endpoint is configured to execute a different budget:

```dotenv
QUORUM_LOCAL_CONTEXT_WINDOW=16384
QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW=4096
QUORUM_LOCAL_CODING_CONTEXT_WINDOW=16384
QUORUM_LOCAL_REASONING_CONTEXT_WINDOW=16384
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
                         ┌──────────┴──────────┐
                         │                     │
                 Local providers       Cloud providers
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
| Balanced | Prefer the strongest suitable local model |
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
