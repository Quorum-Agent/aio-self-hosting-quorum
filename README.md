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
- Five execution policies: Private, Balanced, Best quality, Offline, and Cost controlled
- Request compilation into intents and required capabilities
- Specialty-aware model routing with fail-closed handling for sensitive content
- A live execution inspector showing steps, route, model, and cloud usage
- Server-sent event streaming from orchestrator to UI
- Local SQLite storage under `./var`
- OpenAI-compatible model adapter
- Automatic discovery of configured local models and experts
- A deterministic in-process responder when no configured model is available
- Production build served by the API process

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

The minimum default configuration expects Ollama's OpenAI-compatible endpoint and a
`qwen3:4b` general model:

```bash
ollama pull qwen3:4b
```

Two optional text experts can be installed before Quorum starts:

```bash
ollama pull qwen2.5-coder:1.5b
ollama pull qwen3.5:2b
```

Balanced, Private, and Cost controlled modes route coding work to the coding expert,
math and logic work to the reasoning expert, and ordinary conversation to the general
model. A missing expert is not registered and cannot be selected.

Restart Quorum after installing models. To change any model role:

```bash
copy .env.example .env
```

Then change `QUORUM_LOCAL_MODEL`, `QUORUM_LOCAL_CODING_MODEL`, or
`QUORUM_LOCAL_REASONING_MODEL` in `.env`. Quorum only registers a provider after the
configured model appears in the endpoint's `/models` response, so a reachable server
cannot be mistaken for a ready model.

### Optional cloud fallback

Set these values in `.env`:

```dotenv
QUORUM_CLOUD_BASE_URL=https://api.openai.com/v1
QUORUM_CLOUD_MODEL=gpt-4.1-mini
QUORUM_CLOUD_API_KEY=your-key
```

The cloud provider is not registered when the key is blank. Private and Offline modes
never select a cloud model. Requests detected as sensitive fail closed if no suitable
local route exists.

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
| Best quality | Select the highest-rated eligible model, including cloud |
| Offline | In-process providers only; no loopback or remote model calls |
| Cost controlled | Prefer local models; cloud budgeting is reserved for the usage ledger milestone |

The policy types deliberately include future tool/network controls even where the
first slice only routes models.

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
