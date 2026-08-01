# 002: orchestration-events-in-loop

## Question

**Given** a Python orchestrator port (async generator of plan/trace/delta/result/error),
**when** a chat turn executes through the simulated agent loop,
**then** do the events stream to a consumer in order, with content filtering
(private thinking withheld) and per-attempt ledger semantics matching the TS contract —
and can a consumer render an inspector-grade record from them?

## Why this matters

The inspector is the product differentiator. The TS orchestrator is an async event
generator precisely so the transport can change (HTTP/SSE today, Electron IPC
tomorrow) without coupling the core. The Python port must preserve:
- event ordering and types
- `delta` carrying only validated public answer text (envelope/JSON-schema parsing)
- fallback before any content is emitted, never after
- the attempt ledger (failed off-device contact cannot be erased by a later local result)

## Approach

1. `events.py` — event dataclasses (plan, trace, delta, result, error).
2. `orchestrator.py` — async generator: compile → (analyzer) → plan → model step(s)
   with streaming, envelope validation, fallback within ceiling, attempt ledger.
3. `envelope.py` — the `<quorum-final>...</quorum-final>` envelope + JSON-schema
   answer parser (dual-path like TS: JSON first, then envelope extraction).
4. `providers.py` — fake streaming providers (local, cloud, flaky) yielding chunks.
5. `consumer.py` — collects events into an inspector-grade record (plan summary,
   per-step traces with elapsed, attempts ledger, disclosures).
6. `run.py` — scenarios: happy local, happy cloud (disclosure), provider fails →
   fallback (ledger shows failed attempt), unsafe output (bad envelope) → fallback,
   thinking-model output (reasoning fields withheld).

## Files

- `events.py`, `envelope.py`, `providers.py`, `orchestrator.py`, `consumer.py`, `run.py`

## Verdict: VALIDATED

### What worked
- **Event contract preserved**: `plan → trace* → delta → result` ordering holds;
  errors carry the plan + attempt ledger. A consumer can build an inspector-grade
  record (route, rationale, per-step traces, attempts with routes and transmission
  flags, disclosures) purely from the event stream — no shared state with the
  orchestrator.
- **Dual-path answer extraction**: strict JSON `{answer}` first, then exactly-one
  envelope; rejects preamble/suffix text, nested tags, repeated tags, visually
  blank content (incl. zero-width padding). 24/24 checks pass.
- **Reasoning channel withheld**: thinking-model chunks are stripped before
  validation and never reach a delta.
- **Fallback semantics**: unsafe output and provider failure both trigger fallback;
  the append-only ledger keeps the failed attempt with its route and transmission
  flag, so a later local success cannot erase earlier off-device contact.
- **Async generator maps 1:1** from TS `AsyncGenerator` to Python `AsyncIterator` —
  the "transport can change without coupling the core" property survives the port.

### What didn't
- Nothing invalidated. Scope deliberately excluded: relay/synthesis mode, web
  retrieval splicing, cancellation, circuit breaking — all belong to the full port,
  not this spike.

### Surprises
- The "release validated content as one bounded delta" behavior (TS does this too,
  per its architecture doc) simplifies the consumer enormously: the inspector can
  show a "generating and validating…" state with zero partial-content risk.
- `context_may_have_been_transmitted` on attempts is what makes the ledger honest
  across fallbacks — it fell out naturally from recording `route` per attempt.

### Recommendation for the real build
- Port the full orchestrator into `hermes_routing/` with cancellation (abort
  signals), circuit breaking per provider identity, and the retry budget from
  the TS orchestrator.
- The event stream is the IPC contract for the Electron inspector pane:
  serialize `Event` dataclasses as JSON over the existing backend channel;
  the pane renders them as Quorum's web inspector does today (activity rail
  → tree, since Hermes turns contain tool calls and subagent steps).
- Keep the dual-parser + rejection rules byte-for-byte identical to the TS
  tests; this is the output-safety boundary.

## Program verdict (all three spikes)

| # | Spike | Verdict |
|---|-------|---------|
| 003 | descriptor-bridge | VALIDATED — descriptors derive from catalogs; `remote` is operator-declared |
| 001 | hermes-planner-port | VALIDATED — Python planner matches TS semantics; loop seam enforces non-bypassably |
| 002 | orchestration-events-in-loop | VALIDATED — event contract + output-safety boundary survive the port |

**The architecture holds.** Quorum's core can be ported to Python inside Hermes's
agent loop with the policy model intact, the planner non-bypassable at the
dispatch seam, and the inspector feedable over the Electron backend channel.
Next: the real `hermes_routing/` package with the translated invariant suite.
