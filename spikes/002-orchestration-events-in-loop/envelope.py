"""Public-answer extraction — dual path (JSON first, then envelope).

Mirrors the TS contract: one response, two parsers, no extra round trip.
Rejects: text outside the envelope, nested/repeated reserved tags, empty or
visually-blank content, post-terminal records, incomplete output.
"""

from __future__ import annotations

import json
import re

OPEN_TAG = "<quorum-final>"
CLOSE_TAG = "</quorum-final>"


class UnsafeOutput(ValueError):
    pass


def _visually_blank(s: str) -> bool:
    return not s.strip().strip("\u200b\u00a0\ufeff")


def extract_public_answer(raw: str) -> str:
    """Return the user-facing answer from a complete model response body.

    Path 1: whole body is a JSON object with exactly an `answer` string.
    Path 2: exactly one <quorum-final> envelope, optional outer whitespace.
    Anything else raises UnsafeOutput.
    """
    # Path 1: strict JSON schema { "answer": string } only.
    stripped = raw.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            if set(parsed.keys()) == {"answer"} and isinstance(parsed["answer"], str):
                answer = parsed["answer"]
                if _visually_blank(answer):
                    raise UnsafeOutput("Answer content is visually blank.")
                return answer
            # A JSON object that isn't the schema is unsafe, fall through to envelope.

    # Path 2: envelope.
    opens = raw.count(OPEN_TAG)
    closes = raw.count(CLOSE_TAG)
    if opens != 1 or closes != 1:
        raise UnsafeOutput(
            f"Expected exactly one envelope, found {opens} open / {closes} close tags."
        )
    start = raw.index(OPEN_TAG) + len(OPEN_TAG)
    end = raw.index(CLOSE_TAG)
    if end < start:
        raise UnsafeOutput("Close tag precedes open tag.")
    preamble = raw[: raw.index(OPEN_TAG)]
    suffix = raw[end + len(CLOSE_TAG) :]
    if preamble.strip() or suffix.strip():
        raise UnsafeOutput("Non-whitespace text outside the envelope.")
    body = raw[start:end]
    if OPEN_TAG in body or CLOSE_TAG in body:
        raise UnsafeOutput("Nested reserved tags inside the envelope.")
    if _visually_blank(body):
        raise UnsafeOutput("Envelope content is visually blank.")
    return body.strip()


def strip_reasoning_fields(chunk: dict) -> dict:
    """Drop structured private-thinking fields from a provider chunk
    (Ollama `thinking`, OpenAI-style `reasoning_content`). What the model puts
    inside a valid answer field is displayed; these channels are withheld."""
    return {k: v for k, v in chunk.items() if k not in ("thinking", "reasoning_content")}
