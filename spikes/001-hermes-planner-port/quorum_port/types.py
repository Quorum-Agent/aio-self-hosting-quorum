"""Types mirror — port of packages/core/src/types.ts (decision surface only)."""

from __future__ import annotations

from dataclasses import dataclass, field

EXECUTION_LOCATIONS = ["device", "local", "network", "remote", "web", "cloud"]


def location_tier(location: str) -> int:
    return EXECUTION_LOCATIONS.index(location)


def leaves_device(location: str) -> bool:
    return location_tier(location) > location_tier("local")


def model_reach(location: str, transport: str) -> str:
    """How far a model actually reaches.

    in_process only downgrades a model that ALSO declares itself local.
    Where location and transport contradict, the FURTHER of the two governs —
    this can only ever return the declared location or something nearer, and
    only when the declaration agrees with it. (Port of types.ts modelReach.)
    """
    return "device" if (transport == "in_process" and location == "local") else location


@dataclass
class PolicyDefinition:
    id: str
    label: str
    intent: str
    inference_ceiling: str
    tool_ceiling: str  # ExecutionLocation or "none"
    prefer_local: bool
    cloud_budget_usd: float | None = None


@dataclass
class ModelDescriptor:
    id: str
    label: str
    provider: str
    location: str  # local|network|remote|cloud
    transport: str  # in_process|loopback|remote
    capabilities: list[str]
    context_window: int
    quality_rating: int
    available: bool = True
    specialties: list[str] = field(default_factory=list)
    role: str | None = None
    cost_per_million_tokens: float | None = None
