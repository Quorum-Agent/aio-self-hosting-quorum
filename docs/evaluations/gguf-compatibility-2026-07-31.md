# GGUF compatibility gate — 2026-07-31

ADR 0001 item 5 requires Quorum to "verify separately downloaded GGUF artifacts and
advertise only models that load successfully in the pinned runtime." This is the first
run of that gate, implemented in `apps/api/src/gguf-compatibility-evaluation.ts`.

- Runtime: llama.cpp `b10192` (`9ebfc3a8c`), Windows CUDA 13.3 build
- Hardware: RTX 4070 Ti SUPER, 16 GB
- Artifacts: the GGUF blobs already in the operator's Ollama store — **nothing was
  downloaded**, because Ollama's blobs *are* GGUF files (verified by magic bytes),
  addressed by digest

The gate loads each artifact through `startManagedLlamaRuntime`, not a hand-rolled
command line, so it exercises the same preset rendering, readiness polling and
authentication the production path uses.

## Results

| Artifact | Verdict |
| --- | --- |
| `qwen3:0.6b` | ok (0.9 s) |
| `qwen2.5-coder:1.5b` | ok (2.3 s) |
| `llama3.2:3b` | ok (3.2 s) |
| `qwen2.5-coder:7b` | ok (5.8 s) |
| `llama3.1:8b` | ok (6.8 s) |
| `phi4-mini` | ok (4.0 s) |
| `mistral-nemo` | ok (16.9 s) |
| `qwen3:4b` | ok — **but thinking cannot be suppressed** |
| `qwen3.5:2b` | **REJECTED** — does not load |
| `qwen3.5:4b` | **REJECTED** — does not load |
| `qwen3.5:9b` | **REJECTED** — does not load |
| `gemma4:e2b` | **REJECTED** — does not load |

## What this means for the current configuration

**Both shipped defaults fail.** `QUORUM_LOCAL_MODEL` is `qwen3.5:9b` and
`QUORUM_LOCAL_PROMPT_MODEL` is `qwen3.5:2b`, and neither loads on the pinned build.
The spike found this for the 9b; the gate shows it is **family-wide** — every qwen3.5
artifact tested is rejected, and the failure is the same
`qwen35.rope.dimension_sections` metadata mismatch.

So flipping `QUORUM_LOCAL_TRANSPORT` to the managed runtime today produces an app with
no working models, regardless of everything else being correct. That is the concrete
blocker behind deferring the default flip.

Viable replacements are already on disk. `llama3.1:8b` and `mistral-nemo` are the
plausible main-brain candidates; `qwen2.5-coder:7b` and `qwen2.5-coder:1.5b` cover the
coding role; `qwen3:0.6b` is a fast, tiny prompt analyzer.

## `qwen3:4b` and the suppression column

`qwen3:4b` loads and answers, but emits **712 characters of reasoning** with *both*
`reasoning_effort: "none"` and `chat_template_kwargs: {enable_thinking: false}` set.
Neither mechanism works for its template, which upstream llama.cpp treats as
working-as-intended.

That matters because reasoning is drawn from the same budget as the answer. Measured
separately on the same build:

| `max_tokens` | finish | reasoning | content |
| --- | --- | --- | --- |
| 128 | `length` | ≈100 tok | **0 chars** |
| 512 | `stop` | ≈270 tok | 5 chars |

So an artifact in this state is usable but needs headroom, and a caller that budgets
tightly will get empty responses that look like model failure. The gate reports it as a
distinct verdict rather than a pass or a rejection, because it is neither.

This also means `reasoningEffort: "none"` — set on every local role — is **necessary but
not sufficient**. It is honoured by most templates and ignored by some, and which is
which is a property of the artifact, discoverable only by running it.

## Two instrument defects found and fixed during this run

Recorded because a compatibility gate that misjudges artifacts is worse than none.

**A tight probe budget rejected a working model.** The first version used
`max_tokens: 64` and reported `qwen3:4b` as "no output". It answers fine with room to
think. A gate must not fail an artifact for a setting the gate chose.

**GPU contention produced six false rejections.** With Ollama holding 12.7 GB of the
16 GB card, every artifact failed to load — the first with a visible
`cudaStreamCreateWithFlags` error, the rest silently. All six were reported as
"does not load", which is a durable verdict meant to keep a model off a recommendation
list. The gate now checks free VRAM against artifact size, classifies allocation
failures as **INCONCLUSIVE**, and says explicitly that those are not rejections.

## Limitations

- One machine, one build, one quantisation of each model. The verdicts are about
  *these artifacts on this build*, which is the whole point of a gate, but they do not
  generalise to other quantisations of the same model.
- "Answers" is a single short probe, not a quality measurement. It distinguishes
  working from broken, nothing more.
- Load times include process spawn and are not comparable to steady-state latency.
