"""Spike 002 runner: orchestration scenarios → inspector records."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from consumer import consume
from orchestrator import Orchestrator
from providers import (
    blank_envelope,
    cloud_answer,
    flaky,
    json_answer,
    local_answer,
    thinking_then_answer,
    unsafe_envelope,
)

PASS = "PASS"
FAIL = "FAIL"
failures: list[str] = []


def check(name, cond, detail=""):
    if not cond:
        failures.append(f"{name}: {detail}")
    print(f"  [{PASS if cond else FAIL}] {name} {detail}")


print("== happy local ==")
r = consume(Orchestrator([local_answer("Hello from local.")]).run("hi"))
print(f"  order: {r.event_order}")
check("order plan<trace<delta<result",
      r.event_order[0] == "plan" and "delta" in r.event_order and r.event_order[-1] == "result")
check("content", r.content == "Hello from local.")
check("no disclosure", r.cloud_disclosure is None)
check("attempt completed local", r.attempts[-1]["status"] == "completed" and r.attempts[-1]["route"] == "local")

print("\n== happy cloud (disclosure) ==")
r = consume(Orchestrator([cloud_answer("Hello from cloud.")]).run("hi"))
check("disclosure present", r.cloud_disclosure is not None)
check("attempt route cloud", r.attempts[-1]["route"] == "cloud")
check("transmitted flag", r.attempts[-1]["context_may_have_been_transmitted"] is True)

print("\n== json-schema answer path ==")
r = consume(Orchestrator([json_answer("JSON path answer.")]).run("hi"))
check("json content", r.content == "JSON path answer.")

print("\n== thinking model: reasoning withheld ==")
r = consume(Orchestrator([thinking_then_answer("Visible answer.")]).run("hi"))
check("visible answer", r.content == "Visible answer.")
check("no thinking leaked", "THINKING" not in r.content and "consider this" not in r.content)

print("\n== provider fails → fallback, ledger keeps failed attempt ==")
r = consume(
    Orchestrator(
        [flaky(ConnectionError("ollama down"), "local"), cloud_answer("cloud rescued")]
    ).run("hi")
)
print(f"  attempts: {r.attempts}")
check("content from fallback", r.content == "cloud rescued")
check("ledger has 2 attempts", len(r.attempts) == 2)
check("first attempt failed", r.attempts[0]["status"] == "failed")
check("failed attempt route recorded", r.attempts[0]["route"] == "local")
check("second completed", r.attempts[1]["status"] == "completed" and r.attempts[1]["route"] == "cloud")
check("disclosure after cloud fallback", r.cloud_disclosure is not None)

print("\n== unsafe output (preamble) → rejected → fallback ==")
r = consume(
    Orchestrator([unsafe_envelope(), local_answer("safe local")]).run("hi")
)
check("fallback content", r.content == "safe local")
check("unsafe attempt recorded", any("unsafe output" in (a.get("detail") or "") for a in r.attempts))
check("no unsafe content emitted", "Sure!" not in r.content)

print("\n== blank envelope → rejected ==")
r = consume(Orchestrator([blank_envelope(), local_answer("rescued")]).run("hi"))
check("blank rejected, fallback used", r.content == "rescued")

print("\n== all fail → error event with ledger ==")
r = consume(
    Orchestrator(
        [flaky(ConnectionError("a"), "local"), flaky(TimeoutError("b"), "cloud")]
    ).run("hi")
)
check("error emitted", r.error is not None)
check("no result content", r.result_message is None)
check("ledger keeps both failures", len(r.attempts) == 2 and all(a["status"] == "failed" for a in r.attempts))

print()
if failures:
    print(f"VERDICT DATA: {len(failures)} FAILURES")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("VERDICT DATA: all orchestration scenarios match the TS event contract")
