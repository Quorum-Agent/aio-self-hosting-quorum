"""Spike 003 runner: derive descriptors from recorded fixtures and print them."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from bridge import (
    DescriptorError,
    derive_location,
    descriptor_for_ollama_model,
    descriptor_for_openrouter_model,
)
from fixtures import (
    OLLAMA_SHOW_GEMMA_VISION,
    OLLAMA_SHOW_NO_CAPABILITIES_FIELD,
    OLLAMA_SHOW_NO_CONTEXT,
    OLLAMA_SHOW_QWEN,
    OPENROUTER_MODEL_CLAUDE,
    OPENROUTER_MODEL_DEEPSEEK,
    OPENROUTER_MODEL_NO_CONTEXT,
)

PASS = "PASS"
FAIL = "FAIL"
failures: list[str] = []


def check(name: str, actual, expected) -> None:
    ok = actual == expected
    if not ok:
        failures.append(f"{name}: expected {expected!r}, got {actual!r}")
    print(f"  [{PASS if ok else FAIL}] {name}: {actual!r}")


print("== location derivation ==")
check("loopback IP", derive_location("http://127.0.0.1:11434/v1"), ("local", "loopback"))
check("localhost", derive_location("http://localhost:11434"), ("local", "loopback"))
check(
    "docker DNS",
    derive_location("http://host.docker.internal:11434/v1"),
    ("local", "loopback"),
)
check(
    "unqualified compose name",
    derive_location("http://ollama:11434"),
    ("local", "loopback"),
)
check("RFC-1918 LAN peer", derive_location("http://192.168.1.20:11434/v1"), ("network", "remote"))
check(
    "Tailscale CGNAT peer",
    derive_location("http://100.101.5.30:11434/v1"),
    ("network", "remote"),
)
check("vendor API", derive_location("https://openrouter.ai/api/v1"), ("cloud", "remote"))
# A rented box's public IP is INDISTINGUISHABLE from a vendor API by URL alone —
# location "remote" (you rent the stack) must be operator-declared, never derived.
# 8.8.8.8 stands in for "any public IP": derivation lands on cloud, and an
# operator override is what moves it to remote.
check("public IP derives cloud (remote is operator-declared)", derive_location("http://8.8.8.8:8080/v1"), ("cloud", "remote"))

print()
print("== Ollama descriptors ==")
d = descriptor_for_ollama_model(
    "qwen3.5:9b", base_url="http://127.0.0.1:11434/v1", show_payload=OLLAMA_SHOW_QWEN
)
print(json.dumps(d.__dict__, indent=2))
check("qwen location", d.location, "local")
check("qwen transport", d.transport, "loopback")
check("qwen capabilities", d.capabilities, ["chat", "reasoning", "tools"])
check("qwen context", d.context_window, 32768)

d = descriptor_for_ollama_model(
    "gemma3:12b", base_url="http://127.0.0.1:11434/v1", show_payload=OLLAMA_SHOW_GEMMA_VISION
)
check("gemma capabilities", d.capabilities, ["chat", "vision"])
check("gemma context", d.context_window, 131072)

d = descriptor_for_ollama_model(
    "old-model:latest",
    base_url="http://127.0.0.1:11434/v1",
    show_payload=OLLAMA_SHOW_NO_CAPABILITIES_FIELD,
)
check("old server degrades to chat-only", d.capabilities, ["chat"])
check("old server context via llama.context_length", d.context_window, 8192)

try:
    descriptor_for_ollama_model(
        "mystery:latest", base_url="http://127.0.0.1:11434/v1", show_payload=OLLAMA_SHOW_NO_CONTEXT
    )
    check("missing context raises", "no error", "DescriptorError")
except DescriptorError as e:
    print(f"  [{PASS}] missing context raises DescriptorError: {e}")

print()
print("== Ollama on a Tailscale peer ==")
d = descriptor_for_ollama_model(
    "qwen3.5:9b", base_url="http://100.101.5.30:11434/v1", show_payload=OLLAMA_SHOW_QWEN
)
check("tailscale peer location", d.location, "network")
check("tailscale peer transport", d.transport, "remote")
check("descriptor id carries tier", d.id.startswith("network:"), True)

print()
print("== OpenRouter descriptors ==")
d = descriptor_for_openrouter_model(OPENROUTER_MODEL_CLAUDE)
print(json.dumps(d.__dict__, indent=2))
check("claude location", d.location, "cloud")
check("claude capabilities", d.capabilities, ["chat", "reasoning", "tools", "vision"])
check("claude context", d.context_window, 200000)
check("claude cost present", d.cost_per_million_tokens is not None, True)

d = descriptor_for_openrouter_model(OPENROUTER_MODEL_DEEPSEEK)
check("deepseek text-only", d.capabilities, ["chat", "reasoning", "tools"])
check("deepseek context", d.context_window, 128000)

try:
    descriptor_for_openrouter_model(OPENROUTER_MODEL_NO_CONTEXT)
    check("missing OR context raises", "no error", "DescriptorError")
except DescriptorError as e:
    print(f"  [{PASS}] missing OR context raises DescriptorError: {e}")

print()
if failures:
    print(f"VERDICT DATA: {len(failures)} FAILURES")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("VERDICT DATA: all checks passed")
