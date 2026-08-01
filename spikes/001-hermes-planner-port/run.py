"""Spike 001 runner: a simulated agent loop that must honor planner decisions.

The loop is deliberately naive — the ONLY thing standing between a request
and a provider is the planner's plan. If the planner excludes cloud and the
loop dispatches to cloud anyway, the spike fails loudly.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from quorum_port import ModelDescriptor, Planner
from quorum_port.planner import CompiledRequest, NoRouteError, Requirements

# ── Providers: local Ollama, cloud OpenRouter, LAN peer, in-process scaffold ──

LOCAL = ModelDescriptor(
    id="local:ollama:qwen3.5:9b",
    label="qwen3.5:9b",
    provider="ollama",
    location="local",
    transport="loopback",
    capabilities=["chat", "reasoning", "coding", "documents"],
    context_window=32768,
    quality_rating=75,
)

CLOUD = ModelDescriptor(
    id="cloud:openrouter:claude-sonnet-4.5",
    label="claude-sonnet-4.5",
    provider="openrouter",
    location="cloud",
    transport="remote",
    capabilities=["chat", "reasoning", "coding", "documents"],
    context_window=200000,
    quality_rating=90,
)

LAN_PEER = ModelDescriptor(
    id="network:ollama:qwen3.5:14b",
    label="qwen3.5:14b (LAN)",
    provider="ollama",
    location="network",
    transport="remote",
    capabilities=["chat", "reasoning", "coding", "documents"],
    context_window=32768,
    quality_rating=80,
)

SCAFFOLD = ModelDescriptor(
    id="local:scaffold",
    label="Scaffold",
    provider="quorum",
    location="local",
    transport="in_process",
    capabilities=["chat"],
    context_window=8192,
    quality_rating=5,
)

ALL = [LOCAL, CLOUD, LAN_PEER, SCAFFOLD]

# ── The simulated agent loop ────────────────────────────────────────


class PolicyViolation(RuntimeError):
    pass


def agent_loop_dispatch(plan_model_id: str, request: CompiledRequest, models: list[ModelDescriptor]) -> str:
    """The loop's ONLY dispatch rule: honor the plan. A real loop that
    bypassed the planner would be caught here — this simulates the seam
    where the Python port gates Hermes's model call."""
    by_id = {m.id: m for m in models}
    chosen = by_id[plan_model_id]

    # The loop's own safety re-check (defense in depth, mirroring what the
    # production integration would do): never dispatch off-device for
    # sensitive content, never past the policy ceiling.
    from quorum_port import get_policy, leaves_device, location_tier, model_reach

    policy = get_policy(request.policy)
    if location_tier(model_reach(chosen.location, chosen.transport)) > location_tier(
        policy.inference_ceiling
    ):
        raise PolicyViolation(
            f"LOOP BYPASSED PLANNER: {chosen.id} exceeds {policy.id} ceiling"
        )
    if (
        request.requirements.contains_sensitive_data
        or request.requirements.contains_web_grounded_data
    ) and chosen.location != "local":
        raise PolicyViolation(f"LOOP BYPASSED DATA FLOOR: {chosen.id} is not local")
    return chosen.id


# ── Scenarios ───────────────────────────────────────────────────────

PASS = "PASS"
FAIL = "FAIL"
failures: list[str] = []
planner = Planner()


def req(policy: str, *, sensitive=False, web_grounded=False, freshness=False, caps=("chat",)):
    return CompiledRequest(
        id="r1",
        policy=policy,
        requirements=Requirements(
            capabilities=list(caps),
            requires_freshness=freshness,
            contains_sensitive_data=sensitive,
            contains_web_grounded_data=web_grounded,
        ),
    )


def scenario(name, request, models, expect_model=None, expect_route=None,
             expect_disclosure=None, expect_degraded=None, expect_error=None):
    print(f"\n-- {name} --")
    try:
        plan = planner.plan(request, models)
    except NoRouteError as e:
        if expect_error:
            print(f"  [{PASS}] raised NoRouteError: {e}")
            return
        failures.append(f"{name}: unexpected NoRouteError: {e}")
        print(f"  [{FAIL}] unexpected NoRouteError: {e}")
        return
    if expect_error:
        failures.append(f"{name}: expected NoRouteError, got plan for {plan.model_id}")
        print(f"  [{FAIL}] expected NoRouteError, got plan for {plan.model_id}")
        return

    dispatched = agent_loop_dispatch(plan.model_id, request, models)
    print(f"  plan: model={plan.model_id} route={plan.route} degraded={plan.degraded}")
    print(f"  disclosure: {plan.cloud_disclosure!r}")
    print(f"  loop dispatched: {dispatched}")

    ok = True
    if expect_model is not None and plan.model_id != expect_model:
        ok = False
        failures.append(f"{name}: model {plan.model_id} != expected {expect_model}")
    if expect_route is not None and plan.route != expect_route:
        ok = False
        failures.append(f"{name}: route {plan.route} != expected {expect_route}")
    if expect_disclosure is not None and (plan.cloud_disclosure is not None) != expect_disclosure:
        ok = False
        failures.append(f"{name}: disclosure presence {plan.cloud_disclosure is not None} != {expect_disclosure}")
    if expect_degraded is not None and plan.degraded != expect_degraded:
        ok = False
        failures.append(f"{name}: degraded {plan.degraded} != {expect_degraded}")
    print(f"  [{PASS if ok else FAIL}] expectations")


# The headline invariant: private + sensitive keeps content on the device
# even though the cloud model outranks everything.
scenario(
    "private + sensitive → local, not cloud, no disclosure",
    req("private", sensitive=True),
    ALL,
    expect_model=LOCAL.id,
    expect_route="local",
    expect_disclosure=False,
)

# Private + normal: cloud excluded by ceiling, local wins on preferLocal anyway.
scenario(
    "private + normal → local",
    req("private"),
    ALL,
    expect_model=LOCAL.id,
    expect_disclosure=False,
)

# Quality + normal: cloud wins on quality (prefer_local=False, 90 > 75).
scenario(
    "quality + normal → cloud with disclosure",
    req("quality"),
    ALL,
    expect_model=CLOUD.id,
    expect_route="cloud",
    expect_disclosure=True,
)

# Quality + sensitive: data floor overrides quality ceiling → local.
scenario(
    "quality + sensitive → local despite quality ceiling",
    req("quality", sensitive=True),
    ALL,
    expect_model=LOCAL.id,
    expect_disclosure=False,
)

# Quality + web-grounded history: same floor.
scenario(
    "quality + web-grounded → local (Q-01 semantics)",
    req("quality", web_grounded=True),
    ALL,
    expect_model=LOCAL.id,
    expect_disclosure=False,
)

# Offline: only the in-process scaffold survives a device ceiling.
scenario(
    "offline → scaffold only, degraded",
    req("offline"),
    ALL,
    expect_model=SCAFFOLD.id,
    expect_degraded=True,
    expect_disclosure=False,
)

# Offline without a scaffold: no route at all.
scenario(
    "offline without scaffold → NoRouteError",
    req("offline"),
    [LOCAL, CLOUD, LAN_PEER],
    expect_error=True,
)

# Private with only cloud + scaffold: degrade to scaffold, do NOT weaken policy.
scenario(
    "private with only cloud+scaffold → scaffold, degraded (not cloud)",
    req("private"),
    [CLOUD, SCAFFOLD],
    expect_model=SCAFFOLD.id,
    expect_degraded=True,
    expect_disclosure=False,
)

# Balanced + sensitive: LAN peer is not local → floor keeps it out.
scenario(
    "balanced + sensitive → LAN peer excluded by data floor",
    req("balanced", sensitive=True),
    [LOCAL, LAN_PEER, SCAFFOLD],
    expect_model=LOCAL.id,
    expect_disclosure=False,
)

# Balanced + normal: prefer_local=True but LAN peer rated higher —
# local still wins: localScore 100+75=175 vs 0+80=80.
scenario(
    "balanced + normal → local (preferLocal sort)",
    req("balanced"),
    [LOCAL, LAN_PEER, SCAFFOLD],
    expect_model=LOCAL.id,
    expect_disclosure=False,
)

print()
if failures:
    print(f"VERDICT DATA: {len(failures)} FAILURES")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("VERDICT DATA: all scenarios behaved as the TS planner specifies")
