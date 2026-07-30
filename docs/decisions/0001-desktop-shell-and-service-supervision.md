# ADR 0001: Desktop shell and local-service supervision

- Status: Accepted after managed-runtime spike
- Date: 2026-07-29

## Context

Quorum is currently a browser UI, a Node API, and one or more local services such as
Ollama and, optionally, SearXNG. Requiring a user to install, start, and diagnose each
process undermines the product's local-first experience.

A desktop shell can own installation checks, service lifecycle, health, logs, and
capability disclosure. It does not, by itself, provide a Linux container runtime.
On Windows, Docker's Linux containers still require Docker Desktop or another runtime
backed by WSL 2 or Hyper-V.

## Decision

Add a Tauri 2 desktop application as a thin supervisor around the existing Quorum
web UI. Preserve the current boundaries rather than moving orchestration or model
policy into the shell.

```text
Tauri desktop shell
  ├─ embeds the existing React UI
  ├─ starts and monitors a bundled Quorum API sidecar
  ├─ starts a bundled, pinned llama.cpp runtime sidecar
  │    └─ loads separately downloaded GGUF files by logical model slot
  ├─ optionally discovers Ollama, LM Studio, or another compatible endpoint
  ├─ discovers Docker/Podman when installed
  └─ optionally starts local services through an available backend
         ├─ native packaged sidecar
         └─ Compose service, when a container runtime is present
```

The first desktop milestone should:

1. package the Quorum API as a target-specific sidecar;
2. bind the API to loopback on an ephemeral port and use an authenticated child
   handshake so port squatting fails closed;
3. generate a high-entropy per-launch authentication secret, pass it through a
   non-logged inherited channel, rotate it on every launch, and never place it in a
   URL, command line, renderer storage, or application log;
4. start an authenticated llama.cpp router with web UI, built-in tools, arbitrary
   model autoload, and broad CORS disabled;
5. verify separately downloaded GGUF artifacts and advertise only models that load
   successfully in the pinned runtime;
6. expose start, stop, retry, or configuration controls only when the corresponding
   operation is implemented and its dependency is available;
7. restrict API Origin/CORS and CSRF behavior to the packaged application and approved
   development origins;
8. block remote webview navigation and use a restrictive content-security policy;
9. expose least-privilege Tauri capabilities through narrow Rust commands rather than
   granting the renderer general shell or process-control access;
10. verify signed application, runtime, sidecar, and update artifacts before execution;
11. keep container support optional and terminate child processes fail-closed on exit,
    crash, or failed authentication.

SearXNG can be supervised through Docker or Podman when the user already has a
compatible runtime. Quorum should not claim to install or run it natively until a
maintained cross-platform Python sidecar package, its updates, and its license
obligations are deliberately supported.

## Rejected alternatives

### Treat Tauri as an embedded container runtime

Tauri can launch a container CLI but cannot make Linux containers run natively on
Windows. This would hide, rather than remove, the Docker Desktop/WSL 2 or equivalent
dependency.

### Put the API and UI in one application process

This would couple the interface to orchestration and make headless or remote-client
operation harder. A supervised loopback sidecar keeps the API independently testable
and preserves the current web development workflow.

### Require containers for all local services

This creates unnecessary platform and virtualization requirements for Ollama and the
Quorum API, both of which can run as native processes.

### Require Ollama for the default experience

Ollama remains a useful optional provider, but requiring it makes Quorum depend on a
separately installed model manager and runtime. The managed llama.cpp spike validated
Quorum discovery, structured prompt analysis, validated answer generation, model
switching, cancellation, authentication, and clean process-tree shutdown without
using Ollama for inference. See
[the spike report](../evaluations/managed-llama-runtime-2026-07-30.md).

## Consequences

- The Tauri shell is a product/runtime boundary, not a rewrite of the application.
- The existing Vite UI, Node API, and core package remain reusable.
- Quorum can deliver a single launcher while still supporting headless development.
- Model weights remain separately downloaded and interchangeable; the application
  ships recommendations and verified artifact metadata rather than embedding models.
- Quorum owns pinned runtime builds, hardware variants, model integrity checks,
  lifecycle, logs, and upgrades.
- Some optional capabilities may depend on software installed outside Quorum.
- Packaging, signed updates, port authentication, renderer isolation, least-privilege
  IPC, and fail-closed process cleanup become explicit desktop concerns.
- Capability probes remain authoritative: unavailable operations do not appear as
  working controls.

## References

- Tauri sidecars: <https://v2.tauri.app/develop/sidecar/>
- Tauri Node.js sidecar guide: <https://v2.tauri.app/learn/sidecar-nodejs/>
- llama.cpp server: <https://github.com/ggml-org/llama.cpp/tree/master/tools/server>
- Docker Desktop on Windows: <https://docs.docker.com/desktop/setup/install/windows-install/>
