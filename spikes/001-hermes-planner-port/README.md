# 001: hermes-planner-port

## Question

**Given** a Python port of Quorum's types + policies + route planner,
**when** an agent loop requests a model under a `private` policy with a sensitive request,
**then** does the planner exclude the cloud provider — and does the loop *honor* the
exclusion (degrading safely instead of dispatching to the excluded provider)?

## Why this is the highest-risk spike

The entire integration thesis is "the policy layer sits inside the agent loop and
cannot be bypassed." If a Python port of the planner can't produce a plan the loop
honors — with the same refusal behavior as the TS original — the architecture fails
here, not in production.

## Approach

Port the *minimum* decision surface, not the whole core:

1. `types.py` — ExecutionLocation ordering, `location_tier`, `leaves_device`,
   `model_reach`, PolicyDefinition, ModelDescriptor (reuse spike 003's).
2. `policies.py` — the five shipped policies verbatim (private/balanced/quality/
   offline/cost_controlled).
3. `planner.py` — `plan(compiled_request, models, excluded_ids)`:
   - filter unavailable / unsupported / excluded
   - ceiling filter: `location_tier(model_reach(m)) > location_tier(policy.inference_ceiling)`
   - data floor: sensitive or web-grounded → `location == "local"` only
   - degrade to in-process scaffold when nothing eligible
   - rank: preferLocal → local score (100 + rating + 18/specialty + 20 freshness),
     else quality + specialty, tiebreak context window
4. `simulated_loop.py` — a fake agent loop with three providers (local Ollama,
   cloud OpenRouter, in-process scaffold) that asks the planner for a route and
   **must** honor it or raise.
5. Scenarios: private+sensitive, private+normal, quality+normal (cloud wins),
   offline+normal (scaffold only), offline+no-scaffold (raise), network-peer-under-private.

## Files

- `quorum_port/` — the ported types/policies/planner
- `run.py` — scenario runner printing each plan + the loop's dispatch decision

## Verdict: VALIDATED

### What worked
- All 10 scenarios match TS planner semantics exactly, including the headline
  invariants: private+sensitive stays local (floor, not ceiling), quality+sensitive
  stays local despite a ceiling that permits cloud, offline degrades to the
  in-process scaffold (route comes out `device` via `model_reach`, exactly as TS),
  offline without scaffold raises NoRouteError, and private with only
  cloud+scaffold degrades rather than silently weakening the policy.
- The port is ~250 lines for the decision surface (types+policies+planner) —
  confirms the "days, not weeks" estimate for the full core port.
- **Mutation check**: removing the data floor turns quality+sensitive red (cloud
  wins) — the floor is load-bearing in the Python port exactly as in TS.
- **Loop seam**: a dispatch-time re-check (ceiling + floor) catches what a mutated
  or bypassed planner misses — demonstrating where the Python port gates Hermes's
  model call non-bypassably. The planner decides; the loop enforces.

### What didn't
- Nothing in the port itself. `run.py` has a cosmetic import side-effect
  (scenario execution on import) that muddies the mutation harness output —
  spike-quality code, not production shape.

### Surprises
- `model_reach` downgrading the in-process scaffold to route `device` (not
  `local`) fell out of the port for free — the offline invariant that TS had to
  *stop special-casing by name* works the same way in Python with zero extra code.
- The ranking arithmetic ports with no floating-point or sort-stability concerns —
  Python's `sort` is stable like TS's, and the score is pure integer math.

### Recommendation for the real build
- Port the full core (`compiler`, `orchestrator`) into `hermes_routing/` with the
  invariant test suite translated alongside — same fixtures, same mutations.
- Keep the dispatch-time re-check in the production seam even with a correct
  planner: defense in depth at the exact point of egress is cheap and catches
  both planner bugs and future bypasses introduced by new model-call paths
  (subagents, cron, aux models).
- Next: spike 002 (orchestration events streaming through the loop to a consumer)
  to prove the inspector can be fed from the Python side.
