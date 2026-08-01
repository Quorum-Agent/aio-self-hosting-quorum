import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import {
  buildManagedLlamaArguments,
  loadManagedLlamaManifest,
  managedLlamaProblem,
  renderManagedLlamaPreset,
  startManagedLlamaOrDegrade,
  withManagedLlamaEndpoint,
  type ManagedLlamaManifest,
} from "./managed-llama-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "quorum-llama-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const appConfig: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "silent",
  dataDirectory: "test-data",
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    transport: "ollama",
    models: [
      {
        role: "general",
        name: "quorum-main",
        capabilities: ["chat", "reasoning", "coding", "documents"],
        specialties: [],
        contextWindow: 16_384,
        qualityRating: 75,
      },
    ],
    promptAnalyzer: {
      name: "quorum-prompt",
      contextWindow: 4_096,
    },
    warmOnStartup: true,
  },
};

describe("managed llama.cpp runtime", () => {
  it("loads relative interchangeable GGUF entries and verifies their digest", async () => {
    const directory = await temporaryDirectory();
    const modelPath = join(directory, "prompt.gguf");
    const modelContent = Buffer.from("GGUFfixture");
    await writeFile(modelPath, modelContent);
    const digest = createHash("sha256").update(modelContent).digest("hex");
    const manifestPath = join(directory, "models.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "quorum-prompt",
            file: "./prompt.gguf",
            sha256: digest,
            contextWindow: 4096,
            gpuLayers: 99,
            loadOnStartup: true,
          },
        ],
      }),
    );

    await expect(loadManagedLlamaManifest(manifestPath)).resolves.toEqual({
      version: 1,
      models: [
        {
          id: "quorum-prompt",
          file: modelPath,
          sha256: digest,
          contextWindow: 4096,
          gpuLayers: 99,
          loadOnStartup: true,
        },
      ],
    });
  });

  it("rejects non-GGUF model files", async () => {
    const directory = await temporaryDirectory();
    const modelPath = join(directory, "not-a-model.bin");
    await writeFile(modelPath, "plain text");
    const manifestPath = join(directory, "models.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "duplicate",
            file: modelPath,
            contextWindow: 4096,
          },
        ],
      }),
    );

    await expect(loadManagedLlamaManifest(manifestPath)).rejects.toThrow(
      "is not a GGUF file",
    );
  });

  it("rejects duplicate logical model IDs", async () => {
    const directory = await temporaryDirectory();
    const modelPath = join(directory, "model.gguf");
    await writeFile(modelPath, "GGUFfixture");
    const manifestPath = join(directory, "models.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "duplicate",
            file: modelPath,
            contextWindow: 4096,
          },
          {
            id: "duplicate",
            file: modelPath,
            contextWindow: 4096,
          },
        ],
      }),
    );

    await expect(loadManagedLlamaManifest(manifestPath)).rejects.toThrow(
      "Managed model ID duplicate is duplicated",
    );
  });

  it("renders a router preset with model-specific runtime settings", () => {
    const manifest: ManagedLlamaManifest = {
      version: 1,
      models: [
        {
          id: "quorum-main",
          file: "D:\\models\\main.gguf",
          contextWindow: 16_384,
          gpuLayers: 99,
          loadOnStartup: false,
        },
      ],
    };

    expect(renderManagedLlamaPreset(manifest)).toContain(
      [
        "[quorum-main]",
        "model = D:\\models\\main.gguf",
        "ctx-size = 16384",
        "n-gpu-layers = 99",
        "jinja = true",
        "load-on-startup = false",
      ].join("\n"),
    );
  });

  it("binds the sidecar to loopback and passes only a key-file path", () => {
    const argumentsList = buildManagedLlamaArguments({
      port: 43123,
      apiKeyFile: "C:\\runtime\\api-key.txt",
      presetFile: "C:\\runtime\\models.ini",
    });

    expect(argumentsList).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "43123",
      "--api-key-file",
      "C:\\runtime\\api-key.txt",
      "--models-preset",
      "C:\\runtime\\models.ini",
      "--no-models-autoload",
      "--no-webui",
      "--cors-origins",
      "http://127.0.0.1",
      "--no-cors-credentials",
    ]);
    expect(argumentsList.join(" ")).not.toContain("secret");
  });

  it("replaces the external endpoint only when every configured role exists", () => {
    expect(
      withManagedLlamaEndpoint(appConfig, {
        baseUrl: "http://127.0.0.1:43123/v1",
        apiKey: "ephemeral",
        modelIds: ["quorum-prompt", "quorum-main"],
        contextWindows: new Map(),
      }).local,
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral",
      transport: "openai-compatible",
    });

    expect(() =>
      withManagedLlamaEndpoint(appConfig, {
        baseUrl: "http://127.0.0.1:43123/v1",
        apiKey: "ephemeral",
        modelIds: ["quorum-main"],
        contextWindows: new Map(),
      }),
    ).toThrow("missing configured model IDs: quorum-prompt");
  });

  // The manifest renders contextWindow into the preset as `ctx-size`, so it
  // describes the server that is actually running. Before this, only the
  // endpoint was swapped and the declared window survived, which let
  // fitConversationToContext budget input against a window the server did not
  // have — surfacing as a provider fault rather than a misconfiguration.
  it("takes each model's context window from the manifest, not the environment", () => {
    const reconciled = withManagedLlamaEndpoint(appConfig, {
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral",
      modelIds: ["quorum-prompt", "quorum-main"],
      contextWindows: new Map([
        ["quorum-main", 8_192],
        ["quorum-prompt", 2_048],
      ]),
    }).local;

    expect(appConfig.local.models[0]?.contextWindow).toBe(16_384);
    expect(reconciled.models[0]?.contextWindow).toBe(8_192);
    expect(reconciled.promptAnalyzer.contextWindow).toBe(2_048);
  });

  it("keeps the declared window when the manifest does not name the model", () => {
    const reconciled = withManagedLlamaEndpoint(appConfig, {
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral",
      modelIds: ["quorum-prompt", "quorum-main"],
      contextWindows: new Map([["quorum-main", 8_192]]),
    }).local;

    expect(reconciled.models[0]?.contextWindow).toBe(8_192);
    expect(reconciled.promptAnalyzer.contextWindow).toBe(4_096);
  });

  // An absent Ollama leaves the app usable on the scaffold responder. Any
  // managed-runtime problem used to throw out of index.ts into
  // process.exit(1) — a misconfigured OPTIONAL runtime taking down the whole
  // API. These pin the asymmetry closed.
  describe("degrading instead of exiting", () => {
    it("is a no-op when no managed runtime is configured", async () => {
      let degraded = false;
      const result = await startManagedLlamaOrDegrade(appConfig, () => {
        degraded = true;
      });

      expect(result.runtime).toBeUndefined();
      expect(result.config).toBe(appConfig);
      expect(degraded).toBe(false);
    });

    it("returns the untouched config and reports why, instead of throwing", async () => {
      const configured: AppConfig = {
        ...appConfig,
        managedLlama: {
          executablePath: join(tmpdir(), "definitely-not-a-real-llama-server.exe"),
          manifestPath: join(tmpdir(), "definitely-not-a-real-manifest.json"),
          startupTimeoutMs: 1_000,
        },
      };
      const reported: string[] = [];

      const result = await startManagedLlamaOrDegrade(
        configured,
        (message) => reported.push(message),
      );

      expect(result.runtime).toBeUndefined();
      // Unchanged, so discovery finds no `quorum-main`/`quorum-prompt` and the
      // runtime reports unavailable — it cannot silently answer from some
      // other model that happens to be listening.
      expect(result.config.local.baseUrl).toBe(appConfig.local.baseUrl);
      expect(result.config.local.transport).toBe("ollama");
      expect(reported).toHaveLength(1);
      // The message has to name what to check; "failed to start" sends the
      // operator to the source.
      expect(reported[0]).toContain("QUORUM_MANAGED_LLAMA_SERVER");
      expect(reported[0]).toContain("QUORUM_MANAGED_LLAMA_MODELS");
      expect(reported[0]).toContain("QUORUM_LOCAL_MODEL");
    });
  });

  it("does not mutate the configuration it was given", () => {
    const before = JSON.stringify(appConfig);
    withManagedLlamaEndpoint(appConfig, {
      baseUrl: "http://127.0.0.1:43123/v1",
      apiKey: "ephemeral",
      modelIds: ["quorum-prompt", "quorum-main"],
      contextWindows: new Map([["quorum-main", 8_192]]),
    });
    expect(JSON.stringify(appConfig)).toBe(before);
  });
});

describe("what the interface is told when the managed runtime will not start", () => {
  it("reports the runtime's own words, not a paraphrase of them", () => {
    // Verbatim from llama.cpp b10192 refusing a qwen3.5 artifact.
    const problem = managedLlamaProblem(
      new Error(
        "Managed llama.cpp exited with code 1. error loading model hyperparameters: key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3",
      ),
    );

    expect(problem.summary).toContain("did not start");
    expect(problem.detail).toContain("qwen35.rope.dimension_sections");
  });

  it("survives something thrown that is not an Error", () => {
    expect(managedLlamaProblem("spawn ENOENT").detail).toBe("spawn ENOENT");
  });

  it("strips control characters out of subprocess output", () => {
    // A log tail is untrusted text reaching the interface verbatim. This is the
    // one place it is sanitised, so it is the one place worth asserting.
    const problem = managedLlamaProblem(
      new Error("failed\u0000 to load\u202e reversed"),
    );
    expect(problem.detail).toBe("failed to load reversed");
  });

  it("bounds a long log tail rather than handing the panel a wall of text", () => {
    expect(managedLlamaProblem(new Error("x".repeat(5_000))).detail).toHaveLength(
      600,
    );
  });
});
