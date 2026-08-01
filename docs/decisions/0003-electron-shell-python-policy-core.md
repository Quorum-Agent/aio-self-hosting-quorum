# ADR 0003: Integration with Hermes — Electron shell, Python policy core

- Status: Proposed
- Date: 2026-08-01
- Supersedes: ADR 0001's shell-and-sidecar mechanism (Tauri 2 around a Node Quorum API)

## Context

ADR 0001 was written when Quorum was a standalone TypeScript product: a browser UI, a
Node API, and local model servers. Its mechanism — a Tauri 2 shell supervising a Node
Quorum API sidecar and a pinned llama.cpp sidecar — describes that product.

The product direction has changed. Quorum's durable ideas — the policy ceiling model
(ordered execution-location tiers on two axes), the request compiler (intent,
capabilities, sensitivity floor, web-grounded taint), constraint-before-ranking route
planning, orchestration events with per-attempt disclosure, and validated model output
— are to be integrated into **Hermes desktop** (a clone of NousResearch/Hermes-Agent
at `D:\Repo\hermes-agent`), which already has what Quorum lacks: a packaged Electron
app, a Python agent loop with tools/skills/cron/memory/MCP, channels, and a provider
zoo.

The integration decision that shaped this ADR, made after reviewing both codebases:

**Quorum's policy core ports to Python inside Hermes's agent loop — not the reverse.**

Evidence:

1. **Size asymmetry.** `packages/core` is ~3.5k LOC of zero-dependency TypeScript with
   652 mutation-verified tests. The Hermes agent loop is an order of magnitude larger,
   upstream-maintained, and Python-ecosystem-native (MCP SDK, toolsets, agent-browser).
   Porting Hermes to TypeScript is a 6–12 month fork maintained alone; porting the
   Quorum core is days, and every dependency it does not have is a translation risk
   that does not exist.
2. **Ecosystem pattern.** Routing/policy kernels move *to* the agent runtime, never
   the reverse — LiteLLM is embedded by LangChain/CrewAI/AutoGen; policy engines that
   began as sidecars (OPA) grew embedded ports because a voluntary sidecar is an
   advisory boundary every new code path must remember to consult. A policy layer the
   agent loop can bypass is a policy layer that will be bypassed: by subagents, cron,
   compaction, aux-model calls, and every future tool path.
3. **Dual-implementation value.** A Python port running the same fixtures and the same
   mutation suite becomes the executable specification for any future TypeScript
   reimplementation — two implementations of one invariant set is the strongest
   available check that the logic, not the language, is what is tested.

Given that decision, the shell question had to be reopened, because ADR 0001's
mechanism (Tauri sidecars) was load-bearing for a Node brain and is merely nice
process management for a Python one.

## Decision

**The desktop shell stays Electron.** The Hermes desktop app already spawns and
supervises a Python backend as a managed child process (`backend-child.ts`, with
Windows-aware process-tree teardown). The ported policy core lives *inside* that
Python backend, in the agent loop, where no model call can skip it.

```text
Hermes desktop (Electron, as shipped)
  │
  ├── child: Python backend (Hermes agent loop)
  │     └── quorum-core (Python port)
  │         ├── compiler   (intent, capabilities, sensitivity)
  │         ├── planner    (ceiling-constrained route)
  │         └── orchestrator (plan / trace / delta / result / error events)
  │
  ├── child: llama.cpp server (local inference; managed lifecycle)
  │     └── model storage: NO DEFAULT (operator chooses; first-run prompt)
  │
  └── inspector pane: consumes orchestration events from the Python backend
```

Policy surface: a **global setting with per-session override**. Provider
`location`/`transport`/capabilities are derived from Hermes `ProviderProfile` data
plus live model catalogs where possible; what cannot be discovered (quality rating,
specialties) is operator-declared.

A Tauri migration remains legitimate **as a later optimization**, evaluated with
measurements (installer size, idle RAM) after the integrated product works — not as
a prerequisite, and not on aesthetic grounds.

## What this does not constrain

- **A future Tauri shell.** If measured Electron overhead (hundreds of MB RAM beside
  a VRAM-constrained local-inference machine) justifies it, port the React UI to
  Tauri APIs then. The backend contract (Python child process, event stream) is
  shell-agnostic and survives the move.
- **The llama.cpp sidecar packaging** from ADR 0001 — a pinned runtime, separately
  downloaded weights, logical model slots — stands unchanged.
- **The model-storage-no-default rule** — stands unchanged; it is orthogonal to
  shell choice.
- **How deep the Hermes fork goes.** The integration seam should stay thin: the
  Python policy core as a separable package, adapters from `ProviderProfile`, and an
  event channel to the shell. Upstream Hermes merges should touch the seam, not the
  core.

## Rejected alternatives

- **Port Hermes to TypeScript.** A year-scale solo fork of an upstream-maintained
  project; throws away the Python ecosystem the agent loop depends on.
- **Sidecar/wrapper for the policy core** (Node service or Python RPC the loop calls
  voluntarily). Advisory bypass: every new model-call path must remember to ask, and
  each forgetful path is a silent policy bypass — the exact "one fact, two fields"
  failure shape this project's red-team process exists to catch.
- **Tauri now.** Rebuilds a working shell for process management Electron already
  has, on the strength of benefits (installer size, idle RAM) that have not been
  measured against this product yet.
