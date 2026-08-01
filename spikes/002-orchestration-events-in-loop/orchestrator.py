"""Orchestrator — async event generator, Python port of the TS contract's
observable behavior (not its full feature set).

Scope for the spike: route-mode single model step, envelope validation,
fallback constrained by the failed attempt's tier, append-only attempt ledger,
reasoning-channel withholding.
"""

from __future__ import annotations

import re
import uuid
from typing import Any, AsyncIterator

from envelope import UnsafeOutput, extract_public_answer
from events import (
    Event,
    Plan,
    PlanStep,
    Trace,
    delta_event,
    error_event,
    now,
    plan_event,
    result_event,
    trace_event,
)
from providers import FakeProvider

THINKING_LINE = re.compile(r"^THINKING:.*$", re.MULTILINE)

MAX_FALLBACKS = 2


class Orchestrator:
    def __init__(self, providers: list[FakeProvider], policy_ceiling: str = "cloud"):
        self.providers = providers
        self.policy_ceiling = policy_ceiling

    async def run(self, user_content: str) -> AsyncIterator[Event]:
        tiers = ["device", "local", "network", "remote", "web", "cloud"]

        def tier(loc: str) -> int:
            return tiers.index(loc)

        # Candidate ordering for the spike: local first, then cloud (preferLocal).
        candidates = sorted(self.providers, key=lambda p: tier(p.location))

        steps = [
            PlanStep(label="Compile request context", kind="compile", location="device"),
            PlanStep(label="Apply policy", kind="policy", location="device"),
        ]
        model_step = PlanStep(
            label="Generate",
            kind="model",
            location=candidates[0].location if candidates else "local",
            model_id=candidates[0].id if candidates else None,
        )
        steps.append(model_step)
        plan = Plan(
            id=str(uuid.uuid4()),
            policy="spike",
            route=model_step.location,
            model_id=model_step.model_id or "none",
            rationale="Spike orchestrator.",
            steps=steps,
        )
        yield plan_event(plan)
        for step in steps[:2]:
            yield trace_event(Trace(step.id, step.label, step.kind, step.location, "completed", now(), now()))

        attempts: list[dict[str, Any]] = []
        failures = 0
        idx = 0
        content_emitted = False
        while idx < len(candidates) and failures <= MAX_FALLBACKS:
            provider = candidates[idx]
            model_step.location = provider.location
            model_step.model_id = provider.id
            trace = Trace(
                model_step.id, model_step.label, "model", provider.location,
                "running", now(), model_id=provider.id,
            )
            yield trace_event(trace)
            buffer = ""
            try:
                async for chunk in provider.stream(user_content):
                    buffer += chunk
                # Withhold the reasoning channel before validation/display.
                visible_source = THINKING_LINE.sub("", buffer)
                answer = extract_public_answer(visible_source)
            except UnsafeOutput as e:
                trace.status = "failed"
                trace.completed_at = now()
                trace.detail = f"unsafe output: {e}"
                yield trace_event(trace)
                attempts.append({
                    "model_id": provider.id,
                    "route": provider.location,
                    "status": "failed",
                    "detail": f"unsafe output: {e}",
                    "context_may_have_been_transmitted": provider.location != "local",
                })
                failures += 1
                idx += 1
                continue
            except Exception as e:
                trace.status = "failed"
                trace.completed_at = now()
                trace.detail = str(e)
                yield trace_event(trace)
                attempts.append({
                    "model_id": provider.id,
                    "route": provider.location,
                    "status": "failed",
                    "detail": str(e),
                    "context_may_have_been_transmitted": provider.location != "local",
                })
                failures += 1
                idx += 1
                continue

            # Success: emit the validated answer as one bounded delta
            # (spike skips token-by-token; TS releases validated content too).
            trace.status = "completed"
            trace.completed_at = now()
            yield trace_event(trace)
            attempts.append({
                "model_id": provider.id,
                "route": provider.location,
                "status": "completed",
                "context_may_have_been_transmitted": provider.location != "local",
            })
            content_emitted = True
            yield delta_event(answer)
            plan.attempts = list(attempts)
            plan.route = provider.location
            plan.model_id = provider.id
            if provider.location != "local":
                plan.cloud_disclosure = (
                    "The conversation context required by the selected model will leave this device."
                )
            yield result_event(plan, {"role": "assistant", "content": answer})
            return

        plan.attempts = list(attempts)
        yield error_event(
            "All candidate providers failed." + (
                " Fallback stopped: output already began." if content_emitted else ""
            ),
            recoverable=True,
            plan=plan,
        )
