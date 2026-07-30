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
