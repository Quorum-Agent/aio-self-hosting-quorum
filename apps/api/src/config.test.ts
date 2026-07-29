import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, PROJECT_ROOT } from "./config.js";

const originalDataDirectory = process.env["QUORUM_DATA_DIR"];
const originalLocalModel = process.env["QUORUM_LOCAL_MODEL"];
const originalCodingModel = process.env["QUORUM_LOCAL_CODING_MODEL"];
const originalReasoningModel = process.env["QUORUM_LOCAL_REASONING_MODEL"];
const originalPromptModel = process.env["QUORUM_LOCAL_PROMPT_MODEL"];
const originalPromptContext = process.env["QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW"];
const originalWarmup = process.env["QUORUM_LOCAL_WARMUP"];
const originalGeneralContext = process.env["QUORUM_LOCAL_CONTEXT_WINDOW"];
const originalLocalBaseUrl = process.env["QUORUM_LOCAL_BASE_URL"];
const originalCloudBaseUrl = process.env["QUORUM_CLOUD_BASE_URL"];
const originalCloudApiKey = process.env["QUORUM_CLOUD_API_KEY"];

afterEach(() => {
  const variables = [
    ["QUORUM_DATA_DIR", originalDataDirectory],
    ["QUORUM_LOCAL_MODEL", originalLocalModel],
    ["QUORUM_LOCAL_CODING_MODEL", originalCodingModel],
    ["QUORUM_LOCAL_REASONING_MODEL", originalReasoningModel],
    ["QUORUM_LOCAL_PROMPT_MODEL", originalPromptModel],
    ["QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW", originalPromptContext],
    ["QUORUM_LOCAL_WARMUP", originalWarmup],
    ["QUORUM_LOCAL_CONTEXT_WINDOW", originalGeneralContext],
    ["QUORUM_LOCAL_BASE_URL", originalLocalBaseUrl],
    ["QUORUM_CLOUD_BASE_URL", originalCloudBaseUrl],
    ["QUORUM_CLOUD_API_KEY", originalCloudApiKey],
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
    delete process.env["QUORUM_LOCAL_PROMPT_MODEL"];
    delete process.env["QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW"];
    delete process.env["QUORUM_LOCAL_WARMUP"];

    const config = loadConfig();

    expect(config.local.models).toEqual([
      expect.objectContaining({
        role: "general",
        name: "qwen3:4b",
        specialties: [],
        contextWindow: 16_384,
        reasoningEffort: "none",
      }),
      expect.objectContaining({
        role: "coding",
        name: "qwen2.5-coder:1.5b",
        specialties: ["coding"],
      }),
      expect.objectContaining({
        role: "reasoning",
        name: "qwen3.5:2b",
        specialties: ["reasoning"],
        reasoningEffort: "none",
      }),
    ]);
    expect(config.local.promptAnalyzer).toEqual({
      name: "qwen3:0.6b",
      contextWindow: 4_096,
    });
    expect(config.local.warmOnStartup).toBe(true);
  });

  it("keeps role settings separate when roles use the same physical model", () => {
    process.env["QUORUM_LOCAL_MODEL"] = "one-model";
    process.env["QUORUM_LOCAL_CODING_MODEL"] = "one-model";
    process.env["QUORUM_LOCAL_REASONING_MODEL"] = "one-model";

    const config = loadConfig();

    expect(config.local.models).toEqual([
      expect.objectContaining({
        role: "general",
        name: "one-model",
        specialties: [],
      }),
      expect.objectContaining({
        role: "coding",
        name: "one-model",
        specialties: ["coding"],
      }),
      expect.objectContaining({
        role: "reasoning",
        name: "one-model",
        specialties: ["reasoning"],
        reasoningEffort: "none",
      }),
    ]);
  });

  it("allows an explicit executable context budget per role", () => {
    process.env["QUORUM_LOCAL_CONTEXT_WINDOW"] = "8192";

    expect(loadConfig().local.models[0]?.contextWindow).toBe(8_192);
  });

  it("allows prompt analysis and startup warmup to be configured", () => {
    process.env["QUORUM_LOCAL_PROMPT_MODEL"] = "small-classifier";
    process.env["QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW"] = "2048";
    process.env["QUORUM_LOCAL_WARMUP"] = "false";

    expect(loadConfig().local).toMatchObject({
      promptAnalyzer: {
        name: "small-classifier",
        contextWindow: 2_048,
      },
      warmOnStartup: false,
    });
  });

  it("rejects a remote endpoint configured as local", () => {
    process.env["QUORUM_LOCAL_BASE_URL"] = "https://models.example.com/v1";

    expect(() => loadConfig()).toThrow(
      "QUORUM_LOCAL_BASE_URL must resolve explicitly to localhost",
    );
  });

  it("rejects plaintext cloud endpoints when cloud is configured", () => {
    process.env["QUORUM_CLOUD_API_KEY"] = "configured";
    process.env["QUORUM_CLOUD_BASE_URL"] = "http://api.example.com/v1";

    expect(() => loadConfig()).toThrow(
      "QUORUM_CLOUD_BASE_URL must use HTTPS",
    );
  });
});
