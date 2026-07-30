# Managed llama.cpp runtime spike — 2026-07-30

## Decision summary

**Go** for a Quorum-managed `llama-server` sidecar and interchangeable GGUF
manifest. **No-go** for reusing the currently installed Ollama Qwen 3.5 blobs with
the tested upstream runtime.

The production desktop application should bundle a pinned, signed llama.cpp runtime
for each supported hardware target, but not bundle model weights. Ollama, LM Studio,
and other OpenAI-compatible endpoints remain optional compatibility providers.

## Test environment

- Windows x64
- NVIDIA GeForce RTX 4070 Ti SUPER, 16 GB VRAM
- NVIDIA driver 610.74 / CUDA 13.3
- upstream llama.cpp `b10192` (`9ebfc3a8c`)
- official Windows CUDA 13.3 release archives, verified against GitHub release
  SHA-256 digests before extraction

The executable, CUDA runtime, generated credentials, and model files stayed under
ignored local storage and were not committed.

## Interchangeable model contract

The spike reads a versioned JSON manifest. Each entry maps a stable API-facing ID to
an external GGUF file plus executable context and GPU-layer settings. Quorum selects
the stable ID; replacing the file does not require changing orchestration code.

```json
{
  "version": 1,
  "models": [
    {
      "id": "quorum-prompt",
      "file": "C:/Models/prompt.gguf",
      "contextWindow": 4096,
      "gpuLayers": 999,
      "loadOnStartup": true
    },
    {
      "id": "quorum-main",
      "file": "C:/Models/main.gguf",
      "contextWindow": 16384,
      "gpuLayers": 999,
      "loadOnStartup": true
    }
  ]
}
```

Optional SHA-256 values make startup verify the complete model file. A future model
manager should verify downloads once, record the trusted digest and license, and avoid
rehashing multi-gigabyte files on every ordinary launch.

## Successful transport run

Two already-present, standard GGUF files were used only to validate transport and
lifecycle; this was not a model-quality selection:

- `quorum-prompt`: Qwen3 0.6B Q4_K_M
- `quorum-main`: Llama 3.1 8B Q4_K_M

| Check | Result |
| --- | --- |
| Verified runtime start and two-model load | 11,838.7 ms |
| Quorum runtime discovery | `ready` |
| Prompt classification | `coding`, confidence `1.0`, 161.6 ms |
| First validated main-model response | 1,522.8 ms |
| Second validated main-model response | 233.6 ms |
| Streaming cancellation observed | 1.4 ms |
| Unauthenticated generation | HTTP 401 |
| Router and child-process shutdown | clean |
| Endpoint after shutdown | unavailable |

The full machine-readable result was generated under ignored
`var/managed-llama-runtime/evaluation.json`.

## Qwen 3.5 artifact incompatibility

The first run attempted to reuse the installed Ollama Qwen 3.5 2B and 9B model blobs.
Both failed in upstream llama.cpp before inference:

```text
key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3
```

This does not establish that Qwen 3.5 is unsuitable. It establishes that a model name
and the GGUF magic header are insufficient compatibility checks. Model selection must
test the exact GGUF artifact against Quorum's pinned llama.cpp build. Quorum should
publish recommended artifact digests, not only model-family names.

## Security observations

- The router binds only to `127.0.0.1`.
- A 256-bit credential is generated per launch and supplied by protected key-file path,
  not as a command-line secret.
- Unauthenticated inference is rejected.
- The llama.cpp health and model-catalog endpoints remain public in the tested build;
  the catalog exposes model metadata. Do not place secrets in model IDs or paths.
- The browser never receives the llama.cpp credential; only the Quorum API uses it.
- The model router starts with web UI, built-in tools, arbitrary model autoload, broad
  CORS, and credentialed CORS disabled.
- An API key does not create isolation from a malicious process running as the same OS
  user. The authenticated Tauri-to-Quorum handshake and documented local-process trust
  boundary remain required.

## Remaining production work

1. Move process-tree ownership from the Node spike to a Tauri sidecar supervised with
   platform-native child cleanup.
2. Pin and sign runtime archives for each supported CPU/GPU target.
3. Add a model manager that downloads separately, verifies digest and license, and
   maps a recommended artifact into each logical capability slot.
4. Treat exact runtime/artifact loading as the first gate in the model evaluation
   harness.
5. Add fail-closed ephemeral-port handshaking so a port race cannot redirect Quorum to
   another local process.
