# Handoff — Quorum × Hermes integration (session close 2026-08-01)

> **Location note:** This handoff and the three validated spikes now live in the Quorum
> repo at `aio-self-hosting-quorum/spikes/` (moved from `hermes-agent/spikes/` on
> 2026-08-01). Path mentions of `spikes/...` below are relative to the Quorum repo.
> Agent-loop work (Phase A `hermes_routing/`) still happens in `D:\Repo\hermes-agent`.

Written to end a session that ran long on a broken mechanism. Start the next
session on a **single stable model** (or the MoA panel preset if you want
multi-architecture review). Read this first.

---

## Where the product work actually stands

Decisions made and recorded — none of this is in question:

- **Direction:** Port Quorum's policy core (compiler, planner, orchestrator) to
  Python *inside* Hermes's agent loop. Not a rewrite of Hermes, not a sidecar.
- **Shell:** stays Electron. ADR 0003 (`aio-self-hosting-quorum/docs/decisions/
  0003-electron-shell-python-policy-core.md`, branch
  `docs/adr-0003-electron-shell-python-brain`) records this, superseding ADR
  0001's Tauri mechanism. Tauri revisited later as a measured optimization.
- **Policy surface:** global setting + per-session override.
- **Quorum repo:** clean. Red-team remediation merged (PRs #32, #33); typography/
  contrast fixed; spend-guardrail enforcement + REDTEAM status reconciled.

## Spikes — all three VALIDATED (in `hermes-agent/spikes/`)

- **003 descriptor-bridge** — descriptors derive from provider catalogs; `remote`
  tier must be operator-declared (public IP is indistinguishable from a vendor).
- **001 hermes-planner-port** — Python planner matches TS semantics exactly;
  dispatch-time re-check makes the gate non-bypassable. Mutation-checked.
- **002 orchestration-events** — event contract + output-safety boundary survive
  the port. Async generator maps 1:1 TS→Python.

Spike code is throwaway but `spikes/001-hermes-planner-port/quorum_port/` seeds
the real package.

## The three unknowns — resolved

1. **Model-call seam — RESOLVED, and it is NOT `auxiliary_client.py`.** The main
   loop routes through `relay_llm.py`, not `auxiliary_client.py` directly:
   `conversation_loop.py` calls `relay_llm.execute(request, callback, ...)`
   (`conversation_loop.py:2252`) and `relay_llm.complete_logical_call(...)`
   (`:3331`), where `callback` is `agent._interruptible_api_call` (a forwarder in
   `run_agent.py` → `agent.chat_completion_helpers.interruptible_api_call` →
   `request_client.chat.completions.create(**api_kwargs)` at
   `chat_completion_helpers.py:509/511`). `relay_llm` wraps every call in
   relay/OTEL plumbing when `runtime.managed_execution_enabled()`; otherwise it is a
   transparent passthrough to the callback.
   **Consequence for Phase B:** the policy gate is NOT one inline edit. The chokepoint
   is the `callback(request)` invoke point inside `relay_llm.execute`, and there are
   several variants to intercept — non-streaming `execute` + `stream_execute` (both in
   `relay_llm.py`), `direct_api_call` (nested/cron contexts), and the streaming path
   through `chat_completion_helpers`. Add the gate as a THIN WRAPPER over `api_kwargs`
   right before `chat.completions.create`, not an inline edit, so rebases stay cheap.
   NOTE: `auxiliary_client.py` (~7,900 lines, refactored often upstream) is now known
   to be a *different*, more peripheral layer — gate the `relay_llm`/chat-completion
   funnel instead.

2. **Compiler port — 1–2 days, low risk.** ~700 lines TS → Python stdlib
   (`re`, `unicodedata`, `math.log2`). Spike 002 already proved `\p{Cf}` strip,
   NFKC, envelope parsing work. 211 tests translate mechanically; mutation suite
   is the trust gate. Only trap: JS vs Python regex Unicode-property edges — the
   mutation suite surfaces them.

3. **Fork maintenance — low.** AGENTS.md declares `ProviderProfile` the stable
   seam and plugins the extension point (project policy, not our hope). Integrate
   as a plugin + `hermes_routing/` package. Rebase monthly against tags; mutation
   suite as merge gate; hours per rebase.

## Config change made this session (verified on disk)

`~/AppData/Local/hermes/config.yaml` lines 389-390:
```
delegation:
  model: 'deepseek/deepseek-v4-flash-0731'
  provider: 'openrouter'
```
This is why `delegate_task` now works (smoke test `deleg_4e8d432f` → DELEGATION_OK,
2.2s). Revert if unwanted; only affects future subagent spawns.

## Mechanism facts learned (so the next session doesn't repeat the loop)

- `delegate_task` spawns N children on ONE model (set above). NOT a
  multi-architecture panel.
- The genuine 3-architecture panel = the **MoA reference list** (the `References:`
  block feeding each turn). It's launch/preset config (Providers tab / MoA preset),
  NOT hot-swappable mid-session and NOT the same as delegation. To run a real
  DeepSeek/MiniMax/Hunyuan review: set the MoA references, then start a fresh chat.
- Research briefs persisted: `D:\Repo\hermes-router-design-brief.md` (error
  taxonomy, circuit breaker, OTEL routing record, pin-vs-policy). Descriptor
  schema brief is in session cache.

## Next concrete step

Phase A: create `hermes-agent/hermes_routing/` — port compiler + planner +
orchestrator + envelope, zero-dependency, with the invariant suite translated
alongside (same fixtures, same mutations). Fully self-contained; touches no
Hermes internals. Then Phase B (the seam) after the `conversation_loop.py` read.
