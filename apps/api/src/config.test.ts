import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, PROJECT_ROOT } from "./config.js";

const originalDataDirectory = process.env["QUORUM_DATA_DIR"];
const originalLocalModel = process.env["QUORUM_LOCAL_MODEL"];
const originalCodingModel = process.env["QUORUM_LOCAL_CODING_MODEL"];
const originalReasoningModel = process.env["QUORUM_LOCAL_REASONING_MODEL"];

afterEach(() => {
  const variables = [
    ["QUORUM_DATA_DIR", originalDataDirectory],
    ["QUORUM_LOCAL_MODEL", originalLocalModel],
    ["QUORUM_LOCAL_CODING_MODEL", originalCodingModel],
    ["QUORUM_LOCAL_REASONING_MODEL", originalReasoningModel],
  ] as const;

  for (const [name, value] of variables) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe("loadConfig", () => {
  it("resolves relative data paths from the repository root", () => {
    process.env["QUORUM_DATA_DIR"] = "./test-data";

    expect(loadConfig().dataDirectory).toBe(resolve(PROJECT_ROOT, "test-data"));
  });

  it("configures general, coding, and reasoning model roles", () => {
    delete process.env["QUORUM_LOCAL_MODEL"];
    delete process.env["QUORUM_LOCAL_CODING_MODEL"];
    delete process.env["QUORUM_LOCAL_REASONING_MODEL"];

    const config = loadConfig();

    expect(config.local.models).toEqual([
      expect.objectContaining({
        name: "qwen3:4b",
        specialties: [],
      }),
      expect.objectContaining({
        name: "qwen2.5-coder:1.5b",
        specialties: ["coding"],
      }),
      expect.objectContaining({
        name: "qwen3.5:2b",
        specialties: ["reasoning"],
        reasoningEffort: "none",
      }),
    ]);
  });

  it("merges expert roles when they use the same model", () => {
    process.env["QUORUM_LOCAL_MODEL"] = "one-model";
    process.env["QUORUM_LOCAL_CODING_MODEL"] = "one-model";
    process.env["QUORUM_LOCAL_REASONING_MODEL"] = "one-model";

    const config = loadConfig();

    expect(config.local.models).toHaveLength(1);
    expect(config.local.models[0]).toMatchObject({
      name: "one-model",
      capabilities: ["chat", "reasoning", "coding", "documents"],
      specialties: ["coding", "reasoning"],
      contextWindow: 256_000,
      qualityRating: 60,
      reasoningEffort: "none",
    });
  });
});
