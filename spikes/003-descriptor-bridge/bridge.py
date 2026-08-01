"""Spike 003: Hermes -> Quorum ModelDescriptor bridge.

Derives Quorum-shaped ModelDescriptors from Hermes provider data:
- location tier from base_url semantics (mirroring is_local_endpoint)
- capabilities from catalog metadata where available
- context window from catalog; never guessed

No network, no Hermes imports beyond reading the same hostname rules —
the spike proves the *mapping*, not the wiring.
"""

from __future__ import annotations

import ipaddress
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

# ── Quorum type mirror ──────────────────────────────────────────────

EXECUTION_LOCATIONS = ["device", "local", "network", "remote", "web", "cloud"]

CAPABILITIES = ["chat", "reasoning", "coding", "vision", "documents", "web", "tools"]


@dataclass
class ModelDescriptor:
    id: str
    label: str
    provider: str
    location: str  # local|network|remote|cloud  (device/web excluded for models)
    transport: str  # in_process|loopback|remote
    capabilities: list[str]
    context_window: int
    quality_rating: int = 50  # operator-declared later; neutral default
    specialties: list[str] = field(default_factory=list)
    available: bool = True
    cost_per_million_tokens: float | None = None
    role: str | None = None


class DescriptorError(ValueError):
    pass


# ── Location derivation (mirrors hermes agent/model_metadata.is_local_endpoint) ──

_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}
_CONTAINER_LOCAL_SUFFIXES = (
    "host.docker.internal",
    "host.containers.internal",
    "host.lima.internal",
)
_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def derive_location(base_url: str) -> tuple[str, str]:
    """Return (location, transport) for a provider base URL.

    Quorum's tiers are ordered by how far bytes travel:
      local   = loopback, does not leave the device
      network = your LAN / Tailscale mesh (leaves the device, stays "yours")
      remote  = a box you rent (operator-declared; cannot be derived)
      cloud   = a vendor's API

    Hermes's is_local_endpoint lumps loopback + RFC-1918 + Tailscale into
    "local" for TIMEOUT purposes. Quorum's policy model cannot: a Tailscale
    peer receives the conversation off-device. So the spike splits them:
    loopback -> local, private/Tailscale -> network.
    """
    url = base_url if "://" in base_url else f"http://{base_url}"
    host = (urlparse(url).hostname or "").lower().rstrip(".")

    if host in _LOCAL_HOSTS or host.endswith(".localhost"):
        return "local", "loopback"
    if any(host.endswith(s) for s in _CONTAINER_LOCAL_SUFFIXES):
        return "local", "loopback"
    if host and "." not in host:
        # Unqualified hostname: docker-compose service name, /etc/hosts, mDNS.
        # Hermes calls this local; it resolves on this machine or the LAN.
        # Conservative: treat as loopback only if it resolves to loopback,
        # which we can't know without DNS — spike assumes compose-style
        # same-host networking, matching Hermes's intent.
        return "local", "loopback"
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_loopback:
            return "local", "loopback"
        # is_private covers RFC-1918 AND documentation/reserved ranges
        # (TEST-NET, 192.0.2.0/24 etc.). For an ACCEPTANCE predicate the
        # documentation ranges are not "your LAN" — but they're also not
        # routable, so treating them as network is harmless in practice
        # and keeps this spike simple. The production port should enumerate
        # RFC-1918 explicitly rather than negating a rejection list.
        if addr.is_private or addr.is_link_local:
            return "network", "remote"
        if isinstance(addr, ipaddress.IPv4Address) and addr in _TAILSCALE_CGNAT:
            return "network", "remote"
    except ValueError:
        pass
    return "cloud", "remote"


# ── Capability derivation ───────────────────────────────────────────


def capabilities_from_ollama_show(show_payload: dict[str, Any]) -> list[str]:
    """Ollama /api/show returns a capabilities list on newer versions
    (e.g. ['completion', 'tools', 'thinking', 'vision']). Map to Quorum's."""
    caps = {"chat"}
    raw = set(show_payload.get("capabilities") or [])
    if "thinking" in raw:
        caps.add("reasoning")
    if "vision" in raw:
        caps.add("vision")
    if "tools" in raw:
        caps.add("tools")
    # documents/coding are usage specialties, not API capabilities — declared later
    return sorted(caps)


def capabilities_from_openrouter_model(model_payload: dict[str, Any]) -> list[str]:
    """OpenRouter /models: architecture.modality, supported_parameters."""
    caps = {"chat"}
    arch = model_payload.get("architecture") or {}
    modality = (arch.get("modality") or "")
    if "image" in modality.split("->")[0]:  # input side
        caps.add("vision")
    params = set(model_payload.get("supported_parameters") or [])
    if "tools" in params or "tool_choice" in params:
        caps.add("tools")
    if "reasoning" in params or "include_reasoning" in params:
        caps.add("reasoning")
    return sorted(caps)


# ── Context window ──────────────────────────────────────────────────


def context_window_ollama(show_payload: dict[str, Any], model_id: str) -> int:
    """Prefer model_info's <arch>.context_length; fall back to top-level context_length."""
    info = show_payload.get("model_info") or {}
    for key, value in info.items():
        if key.endswith(".context_length") and isinstance(value, int) and value > 0:
            return value
    top = show_payload.get("context_length")
    if isinstance(top, int) and top > 0:
        return top
    raise DescriptorError(
        f"No context length discoverable for Ollama model {model_id!r}; "
        "declare it explicitly rather than guessing."
    )


def context_window_openrouter(model_payload: dict[str, Any], model_id: str) -> int:
    ctx = model_payload.get("context_length")
    if isinstance(ctx, int) and ctx > 0:
        return ctx
    top = model_payload.get("top_provider") or {}
    ctx = top.get("context_length")
    if isinstance(ctx, int) and ctx > 0:
        return ctx
    raise DescriptorError(
        f"No context length discoverable for OpenRouter model {model_id!r}; "
        "declare it explicitly rather than guessing."
    )


# ── Descriptor assembly ─────────────────────────────────────────────


def descriptor_for_ollama_model(
    model_id: str,
    *,
    base_url: str,
    show_payload: dict[str, Any],
) -> ModelDescriptor:
    location, transport = derive_location(base_url)
    return ModelDescriptor(
        id=f"{location}:ollama:{model_id}",
        label=model_id,
        provider="ollama",
        location=location,
        transport=transport,
        capabilities=capabilities_from_ollama_show(show_payload),
        context_window=context_window_ollama(show_payload, model_id),
    )


def descriptor_for_openrouter_model(
    model_payload: dict[str, Any],
    *,
    base_url: str = "https://openrouter.ai/api/v1",
) -> ModelDescriptor:
    location, transport = derive_location(base_url)
    model_id = model_payload["id"]
    pricing = model_payload.get("pricing") or {}
    try:
        cost = float(pricing.get("prompt", 0)) + float(pricing.get("completion", 0))
        cost = cost if cost > 0 else None
    except (TypeError, ValueError):
        cost = None
    return ModelDescriptor(
        id=f"{location}:openrouter:{model_id}",
        label=model_id,
        provider="openrouter",
        location=location,
        transport=transport,
        capabilities=capabilities_from_openrouter_model(model_payload),
        context_window=context_window_openrouter(model_payload, model_id),
        cost_per_million_tokens=cost,
    )
