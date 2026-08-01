"""Policies — port of packages/core/src/policies.ts, values verbatim."""

from __future__ import annotations

from .types import PolicyDefinition

POLICIES: dict[str, PolicyDefinition] = {
    "private": PolicyDefinition(
        id="private",
        label="Private",
        intent="For work you want handled entirely by software you run yourself.",
        inference_ceiling="local",
        tool_ceiling="none",
        prefer_local=True,
    ),
    "balanced": PolicyDefinition(
        id="balanced",
        label="Balanced",
        intent="The default: prefer what you host, and go further only when it clearly helps.",
        inference_ceiling="cloud",
        tool_ceiling="web",
        prefer_local=True,
    ),
    "quality": PolicyDefinition(
        id="quality",
        label="Best quality",
        intent="The strongest available route for each request.",
        inference_ceiling="cloud",
        tool_ceiling="web",
        prefer_local=False,
    ),
    "offline": PolicyDefinition(
        id="offline",
        label="Offline",
        intent="For a machine with no network, or with none of its model servers running.",
        inference_ceiling="device",
        tool_ceiling="none",
        prefer_local=True,
    ),
    "cost_controlled": PolicyDefinition(
        id="cost_controlled",
        label="Cost controlled",
        intent="Prefer routes that cost nothing, and cap what an exceptional request may spend.",
        inference_ceiling="cloud",
        tool_ceiling="web",
        prefer_local=True,
        cloud_budget_usd=1.0,
    ),
}


def get_policy(mode: str) -> PolicyDefinition:
    return POLICIES[mode]
