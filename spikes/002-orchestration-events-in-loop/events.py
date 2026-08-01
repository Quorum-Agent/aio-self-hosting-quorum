"""Orchestration events — Python mirror of the TS event contract."""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any


def _id() -> str:
    return str(uuid.uuid4())


@dataclass
class PlanStep:
    label: str
    kind: str  # compile|classification|policy|retrieval|model|synthesis
    location: str
    id: str = field(default_factory=_id)
    model_id: str | None = None


@dataclass
class Plan:
    id: str
    policy: str
    route: str
    model_id: str
    rationale: str
    steps: list[PlanStep]
    degraded: bool = False
    cloud_disclosure: str | None = None
    attempts: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class Trace:
    step_id: str
    label: str
    kind: str
    location: str
    status: str  # pending|running|completed|failed
    started_at: float
    completed_at: float | None = None
    detail: str | None = None
    model_id: str | None = None
    id: str = field(default_factory=_id)


@dataclass
class Event:
    type: str  # plan|trace|delta|result|error
    payload: Any


def plan_event(plan: Plan) -> Event:
    return Event("plan", plan)


def trace_event(trace: Trace) -> Event:
    return Event("trace", trace)


def delta_event(content: str) -> Event:
    return Event("delta", content)


def result_event(plan: Plan, message: dict[str, Any]) -> Event:
    return Event("result", {"plan": plan, "message": message})


def error_event(message: str, *, recoverable: bool, plan: Plan | None = None,
                partial_content: str | None = None) -> Event:
    return Event("error", {
        "message": message,
        "recoverable": recoverable,
        "plan": plan,
        "partial_content": partial_content,
    })


def now() -> float:
    return time.time()
