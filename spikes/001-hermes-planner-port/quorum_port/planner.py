"""Route planner — 1:1 port of packages/core/src/route-planner.ts."""

from __future__ import annotations

from dataclasses import dataclass, field

from .policies import get_policy
from .types import ModelDescriptor, location_tier, model_reach

SPECIALTY_BONUS = 18
LOCAL_BONUS = 100
FRESHNESS_BONUS = 20


@dataclass
class Requirements:
    capabilities: list[str]
    requires_freshness: bool = False
    contains_sensitive_data: bool = False
    contains_web_grounded_data: bool = False


@dataclass
class CompiledRequest:
    id: str
    policy: str
    requirements: Requirements


@dataclass
class PlanResult:
    route: str
    model_id: str
    rationale: str
    degraded: bool = False
    cloud_disclosure: str | None = None


def _supports(model: ModelDescriptor, request: CompiledRequest) -> bool:
    return all(c in model.capabilities for c in request.requirements.capabilities)


def _matched_specialties(model: ModelDescriptor, request: CompiledRequest) -> list[str]:
    return [
        s
        for s in dict.fromkeys(model.specialties)
        if s != "chat" and s in request.requirements.capabilities
    ]


def _specialty_score(model: ModelDescriptor, request: CompiledRequest) -> int:
    return len(_matched_specialties(model, request)) * SPECIALTY_BONUS


def _local_score(model: ModelDescriptor, request: CompiledRequest) -> int:
    score = LOCAL_BONUS if model.location == "local" else 0
    score += model.quality_rating
    score += _specialty_score(model, request)
    if request.requirements.requires_freshness and "web" in model.capabilities:
        score += FRESHNESS_BONUS
    return score


def _physical_identity(model: ModelDescriptor) -> str:
    return f"{model.location}:{model.provider}:{model.label}"


class NoRouteError(ValueError):
    pass


class Planner:
    def plan(
        self,
        request: CompiledRequest,
        models: list[ModelDescriptor],
        excluded_model_ids: frozenset[str] | None = None,
    ) -> PlanResult:
        excluded = excluded_model_ids or frozenset()
        policy = get_policy(request.policy)

        # 1-3. availability, capability, ceiling — one comparison, no policy named.
        eligible = [
            m
            for m in models
            if m.id not in excluded
            and m.available
            and _supports(m, request)
            and location_tier(model_reach(m.location, m.transport))
            <= location_tier(policy.inference_ceiling)
        ]

        # 4. Data floor — equality, not ceiling: sensitive/web-grounded content
        # stays on the device even when the policy would permit a LAN peer.
        requires_local = (
            request.requirements.contains_sensitive_data
            or request.requirements.contains_web_grounded_data
        )
        candidates = [m for m in eligible if m.location == "local"] if requires_local else eligible

        # Degrade to the in-process scaffold when nothing eligible remains.
        degraded = False
        if not candidates:
            candidates = [
                m
                for m in models
                if m.id not in excluded
                and m.available
                and m.location == "local"
                and m.transport == "in_process"
                and m.provider == "quorum"
                and "chat" in m.capabilities
            ]
            degraded = bool(candidates)
        if not candidates:
            raise NoRouteError(
                f"No available model satisfies the {policy.label} policy "
                "and required capabilities."
            )

        # 5. Rank.
        if policy.prefer_local:
            candidates.sort(key=lambda m: _local_score(m, request), reverse=True)
        else:
            candidates.sort(
                key=lambda m: (
                    m.quality_rating + _specialty_score(m, request),
                    m.context_window,
                ),
                reverse=True,
            )
        selected = candidates[0]
        degraded = degraded or selected.id == "local:scaffold"

        matched = _matched_specialties(selected, request)
        from .types import leaves_device

        if degraded:
            rationale = (
                f"{policy.label} mode found no model with every required capability; "
                "the local scaffold will explain the limitation."
            )
        elif not leaves_device(selected.location):
            rationale = (
                f"{policy.label} mode selected a local {' and '.join(matched)} specialist."
                if matched
                else f"{policy.label} mode selected an available local model with the required capabilities."
            )
        else:
            rationale = (
                f"{policy.label} mode selected a {selected.location} model because it "
                "best matches the request requirements."
            )

        route = model_reach(selected.location, selected.transport)
        return PlanResult(
            route=route,
            model_id=selected.id,
            rationale=rationale,
            degraded=degraded,
            cloud_disclosure=(
                "The conversation context required by the selected model will leave this device."
                if leaves_device(route)
                else None
            ),
        )
