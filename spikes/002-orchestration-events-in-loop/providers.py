"""Fake streaming providers for spike 002."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import AsyncIterator


@dataclass
class FakeProvider:
    id: str
    label: str
    location: str  # local|cloud
    chunks: list[str]
    fail_with: Exception | None = None
    latency: float = 0.0

    async def stream(self, prompt: str) -> AsyncIterator[str]:
        if self.fail_with is not None:
            if self.latency:
                await asyncio.sleep(self.latency)
            raise self.fail_with
        for chunk in self.chunks:
            if self.latency:
                await asyncio.sleep(self.latency)
            yield chunk


def local_answer(text: str) -> FakeProvider:
    return FakeProvider(
        id="local:ollama:test",
        label="local-test",
        location="local",
        chunks=[f'<quorum-final>{text}</quorum-final>'],
    )


def cloud_answer(text: str) -> FakeProvider:
    return FakeProvider(
        id="cloud:openrouter:test",
        label="cloud-test",
        location="cloud",
        chunks=[f'<quorum-final>{text}</quorum-final>'],
    )


def json_answer(text: str, location: str = "local") -> FakeProvider:
    import json as _json

    return FakeProvider(
        id=f"{location}:json:test",
        label="json-test",
        location=location,
        chunks=[_json.dumps({"answer": text})],
    )


def thinking_then_answer(text: str) -> FakeProvider:
    """Ollama thinking model: reasoning chunks precede the visible answer.
    The orchestrator must withhold the thinking channel."""
    return FakeProvider(
        id="local:thinking:test",
        label="thinking-test",
        location="local",
        chunks=[
            "THINKING: let me consider this carefully...\n",
            f'<quorum-final>{text}</quorum-final>',
        ],
    )


def flaky(error: Exception, location: str = "local") -> FakeProvider:
    return FakeProvider(
        id=f"{location}:flaky:test",
        label="flaky-test",
        location=location,
        chunks=[],
        fail_with=error,
    )


def unsafe_envelope() -> FakeProvider:
    """Preamble + envelope — must be rejected as unsafe."""
    return FakeProvider(
        id="local:unsafe:test",
        label="unsafe-test",
        location="local",
        chunks=["Sure! Here is your answer: <quorum-final>hi</quorum-final>"],
    )


def blank_envelope() -> FakeProvider:
    return FakeProvider(
        id="local:blank:test",
        label="blank-test",
        location="local",
        chunks=["<quorum-final>   \u200b  </quorum-final>"],
    )
