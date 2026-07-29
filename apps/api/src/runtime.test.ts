import { describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import { createLocalProviders } from "./runtime.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "silent",
  dataDirectory: "test-data",
  local: {
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
    models: [
      {
        name: "general",
        capabilities: ["chat", "reasoning", "coding"],
        specialties: [],
        contextWindow: 32_000,
        qualityRating: 60,
      },
      {
        name: "code",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
        contextWindow: 32_000,
        qualityRating: 50,
      },
      {
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

describe("createLocalProviders", () => {
  it("registers only installed configured experts", () => {
    const providers = createLocalProviders(config, ["general", "code"]);

    expect(providers.map((provider) => provider.model)).toEqual([
      expect.objectContaining({
        id: "local:general",
        specialties: [],
      }),
      expect.objectContaining({
        id: "local:code",
        capabilities: ["chat", "coding"],
        specialties: ["coding"],
      }),
    ]);
  });

  it("registers no phantom provider for a missing model", () => {
    expect(createLocalProviders(config, [])).toEqual([]);
  });
});
