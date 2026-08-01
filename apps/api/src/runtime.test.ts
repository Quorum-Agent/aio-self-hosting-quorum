import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.js";
import {
  createLocalProviders,
  createRuntime,
  currentLocalRuntime,
  describeLocalRuntime,
} from "./runtime.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "silent",
  dataDirectory: "test-data",
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    transport: "ollama",
    promptAnalyzer: {
      name: "classifier",
      contextWindow: 4_096,
    },
    warmOnStartup: true,
    models: [
      {
        role: "general",
        name: "general",
        capabilities: ["chat", "reasoning", "coding"],
        specialties: [],
        contextWindow: 32_000,
        qualityRating: 60,
      },
      {
        role: "coding",
        name: "code",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
        contextWindow: 32_000,
        qualityRating: 50,
      },
      {
        role: "reasoning",
        name: "reasoning",
        capabilities: ["chat", "reasoning"],
        specialties: ["reasoning"],
        contextWindow: 128_000,
        qualityRating: 55,
        reasoningEffort: "none",
      },
    ],
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLocalProviders", () => {
  it("registers only installed configured experts", () => {
    const providers = createLocalProviders(config, ["general", "code"]);

    expect(providers.map((provider) => provider.model)).toEqual([
      expect.objectContaining({
        id: "local:general:general",
        role: "general",
        specialties: [],
      }),
      expect.objectContaining({
        id: "local:coding:code",
        role: "coding",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
      }),
    ]);
  });

  it("registers no phantom provider for a missing model", () => {
    expect(createLocalProviders(config, [])).toEqual([]);
  });

  it("matches an omitted configured tag to Ollama's explicit latest tag", () => {
    const providers = createLocalProviders(config, [
      "general:latest",
      "code:latest",
    ]);

    expect(providers.map((provider) => provider.model.role)).toEqual([
      "general",
      "coding",
    ]);
  });

  // The managed llama.cpp path has two gates that disagreed about case:
  // waitUntilReady lowercases both sides before comparing catalogue IDs, while
  // this check compared exactly. An uppercase manifest ID passed startup and
  // then failed discovery, leaving the runtime degraded with the UI blaming a
  // missing model.
  it("matches a configured model whose catalogue spelling differs in case", () => {
    const providers = createLocalProviders(config, ["General", "CODE"]);

    expect(providers.map((provider) => provider.model.role)).toEqual([
      "general",
      "coding",
    ]);
  });

  it("is ready only when every configured role is available", () => {
    const providers = createLocalProviders(config, ["general", "code", "reasoning"]);

    expect(describeLocalRuntime(config, true, providers, true)).toMatchObject({
      state: "ready",
      endpointConnected: true,
      roles: [
        { role: "general", required: true, available: true },
        { role: "coding", required: false, available: true },
        { role: "reasoning", required: false, available: true },
      ],
      promptAnalyzer: {
        configuredModel: "classifier",
        available: true,
      },
    });
  });

  it("reports degraded instead of ready when the general role is missing", () => {
    const providers = createLocalProviders(config, ["code", "reasoning"]);

    expect(describeLocalRuntime(config, true, providers, true)).toMatchObject({
      state: "degraded",
      endpointConnected: true,
      roles: [
        { role: "general", available: false },
        { role: "coding", available: true },
        { role: "reasoning", available: true },
      ],
    });
  });

  it("reports an unavailable endpoint separately from missing models", () => {
    expect(describeLocalRuntime(config, false, [], false)).toMatchObject({
      state: "unavailable",
      endpointConnected: false,
    });
  });

  it("derives current role health from circuit-aware model availability", () => {
    const providers = createLocalProviders(config, ["general", "code", "reasoning"]);
    const discovered = describeLocalRuntime(config, true, providers, true);
    const current = currentLocalRuntime(
      discovered,
      providers.map((provider) =>
        provider.model.role === "coding"
          ? { ...provider.model, available: false }
          : provider.model,
      ),
    );

    expect(current).toMatchObject({
      state: "degraded",
      roles: [
        { role: "general", available: true },
        { role: "coding", available: false },
        { role: "reasoning", available: true },
      ],
    });
  });

  it("reports a missing prompt analyzer as degraded without inventing a provider", () => {
    const providers = createLocalProviders(config, [
      "general",
      "code",
      "reasoning",
    ]);

    expect(describeLocalRuntime(config, true, providers, false)).toMatchObject({
      state: "degraded",
      promptAnalyzer: {
        configuredModel: "classifier",
        available: false,
      },
    });
  });

  it("discovers every configured role when the model server starts after Quorum", async () => {
    let online = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        online
          ? new Response(
              JSON.stringify({
                data: [
                  { id: "classifier" },
                  { id: "general" },
                  { id: "code" },
                  { id: "reasoning" },
                ],
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            )
          : new Response("not ready", { status: 503 }),
      ),
    );
    const runtime = await createRuntime({
      ...config,
      local: { ...config.local, warmOnStartup: false },
    });

    expect(runtime.localRuntime.state).toBe("unavailable");
    online = true;
    await runtime.refreshLocalModels();

    expect(runtime.localRuntime).toMatchObject({
      state: "ready",
      endpointConnected: true,
      roles: [
        { role: "general", available: true },
        { role: "coding", available: true },
        { role: "reasoning", available: true },
      ],
      promptAnalyzer: { available: true },
    });
  });
});

describe("a local runtime that cannot serve says why", () => {
  const problem = {
    summary:
      "The managed llama.cpp runtime did not start, so no local model is being served.",
    detail:
      "Managed llama.cpp exited with code 1. error loading model hyperparameters: key qwen35.rope.dimension_sections has wrong array length; expected 4, got 3",
  };

  it("carries the cause the startup path already caught", () => {
    expect(describeLocalRuntime(config, false, [], false, problem)).toMatchObject(
      { state: "unavailable", problem },
    );
  });

  it("claims nothing when nothing knows a cause", () => {
    expect(describeLocalRuntime(config, false, [], false).problem).toBeUndefined();
  });

  // The status is rebuilt on every poll and every chat dispatch. Dropping the
  // cause here would show it once, on the first read after startup, and then
  // silently lose it — leaving an operator who saw the reason unable to find it
  // again. The fixture keeps the endpoint disconnected so the surviving field
  // is the only difference between the two shapes.
  it("keeps the cause across a status refresh", () => {
    const discovered = describeLocalRuntime(config, false, [], false, problem);
    expect(currentLocalRuntime(discovered, []).problem).toEqual(problem);
  });

  it("does not invent a cause when the discovered status had none", () => {
    const discovered = describeLocalRuntime(config, false, [], false);
    expect(currentLocalRuntime(discovered, []).problem).toBeUndefined();
  });
});
