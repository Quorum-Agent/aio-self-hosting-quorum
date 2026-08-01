"""Consumer: collect orchestration events into an inspector-grade record."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from events import Event


@dataclass
class InspectorRecord:
    plan: dict[str, Any] | None = None
    traces: list[dict[str, Any]] = field(default_factory=list)
    content: str = ""
    result_message: str | None = None
    error: str | None = None
    attempts: list[dict[str, Any]] = field(default_factory=list)
    cloud_disclosure: str | None = None

    @property
    def event_order(self) -> list[str]:
        return self._order

    _order: list[str] = field(default_factory=list)


def consume(events) -> InspectorRecord:
    """Drain an async event generator into a record an inspector can render."""
    import asyncio

    record = InspectorRecord()

    async def _run():
        async for event in events:
            record._order.append(event.type)
            if event.type == "plan":
                p = event.payload
                record.plan = {
                    "route": p.route,
                    "model_id": p.model_id,
                    "rationale": p.rationale,
                    "degraded": p.degraded,
                }
                record.cloud_disclosure = p.cloud_disclosure
                record.attempts = list(p.attempts)
            elif event.type == "trace":
                t = event.payload
                record.traces.append({
                    "label": t.label,
                    "kind": t.kind,
                    "location": t.location,
                    "status": t.status,
                    "detail": t.detail,
                    "model_id": t.model_id,
                })
            elif event.type == "delta":
                record.content += event.payload
            elif event.type == "result":
                record.result_message = event.payload["message"]["content"]
                p = event.payload["plan"]
                record.plan = {
                    "route": p.route,
                    "model_id": p.model_id,
                    "rationale": p.rationale,
                    "degraded": p.degraded,
                }
                record.cloud_disclosure = p.cloud_disclosure
                record.attempts = list(p.attempts)
            elif event.type == "error":
                record.error = event.payload["message"]
                if event.payload.get("plan"):
                    record.attempts = list(event.payload["plan"].attempts)

    asyncio.run(_run())
    return record
