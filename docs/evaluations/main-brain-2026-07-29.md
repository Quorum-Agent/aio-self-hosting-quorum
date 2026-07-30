# Main-brain candidate evaluation — 2026-07-29

## Environment

- GPU: NVIDIA GeForce RTX 4070 Ti SUPER, 16 GB VRAM
- Ollama: 0.31.2
- Dispatch context target: 16,384 tokens
- Generation: temperature 0, private thinking disabled where supported

This was a focused routing decision check, not a general model leaderboard. Each
candidate received the same relevant system instruction and task text.

## Results

| Model | Case | Time | Finding |
| --- | --- | ---: | --- |
| `qwen3.5:9b` | conversation continuation | 4.5 s | Cleanly continued the prior subject with no process narration |
| `ministral-3:8b` | conversation continuation | 6.7 s | Continued, but repeated prior headings and introduced dubious examples |
| `qwen3.5:9b` | Tauri/container architecture | 8.7 s | Correct recommendation and correctly retained the Windows virtualization constraint |
| `ministral-3:8b` | Tauri/container architecture | 7.4 s | Contradicted itself by claiming optional Linux Docker could avoid WSL 2 |
| `qwen3.5:9b` | Oracle/Node dynamic pivot | 9.7 s | Failed: invented `oracledb` APIs and did not produce a valid pivot |
| `ministral-3:8b` | Oracle/Node dynamic pivot | 7.0 s | Failed: invalid bind-variable and PIVOT construction |
| `qwen2.5:14b` | Oracle/Node dynamic pivot | 20.0 s | Failed: invented `connection.escapeIdentifier` and produced invalid SQL |
| `deepcoder` | Oracle/Node dynamic pivot | 21.5 s | Failed: attempted to bind an identifier and spent its budget in private reasoning |
| `qwen2.5-coder:7b` | Oracle/Node dynamic pivot | 8.5 s | Failed: returned an application-side map instead of the requested Oracle pivot |

## Decision

- Use `qwen3.5:9b` as the current default main brain.
- Keep `qwen3.5:2b` exclusively as the prompt compiler.
- Do not configure a default answer specialist from this candidate set.
- Keep specialist routes opt-in until a representative task suite establishes a real
  improvement over the main brain.

The downloaded alternatives remain available for later suites. A specialist that
fails should not be promoted merely because its name or model card describes it as
specialized.

A follow-up runtime smoke test also confirmed that `qwen3.5:9b` produces the required
native Ollama JSON-schema answer object with thinking disabled. Quorum validates that
object before displaying its `answer` field.

When specialists are enabled in a later milestone, they should return bounded
artifacts (for example code, calculations, or retrieved evidence) to the main brain.
The main brain should retain the conversation and produce the user-facing response:

```text
prompt compiler -> optional specialist/tool -> main brain -> user
```

This is a target orchestration stage, not the current direct answer-route behavior.
Until it is implemented and evaluated, answer-specialist environment variables remain
optional and unset by default.
