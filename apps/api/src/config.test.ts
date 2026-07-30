import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, PROJECT_ROOT } from "./config.js";

const originalDataDirectory = process.env["QUORUM_DATA_DIR"];
const originalHost = process.env["HOST"];
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
const originalWebSearchProvider =
  process.env["QUORUM_WEB_SEARCH_PROVIDER"];
const originalWebSearchEnabled =
  process.env["QUORUM_WEB_SEARCH_ENABLED"];
const originalWebSearchResultLimit =
  process.env["QUORUM_WEB_SEARCH_RESULT_LIMIT"];
const originalSearxngBaseUrl = process.env["QUORUM_SEARXNG_BASE_URL"];
const originalExaSearchApiKey =
  process.env["QUORUM_EXA_SEARCH_API_KEY"];
const originalPerplexitySearchApiKey =
  process.env["QUORUM_PERPLEXITY_SEARCH_API_KEY"];
const originalTavilySearchApiKey =
  process.env["QUORUM_TAVILY_SEARCH_API_KEY"];
const originalBraveSearchApiKey =
  process.env["QUORUM_BRAVE_SEARCH_API_KEY"];
const originalFirecrawlSearchApiKey =
  process.env["QUORUM_FIRECRAWL_SEARCH_API_KEY"];

afterEach(() => {
  const variables = [
    ["QUORUM_DATA_DIR", originalDataDirectory],
    ["HOST", originalHost],
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
    ["QUORUM_WEB_SEARCH_PROVIDER", originalWebSearchProvider],
    ["QUORUM_WEB_SEARCH_ENABLED", originalWebSearchEnabled],
    ["QUORUM_WEB_SEARCH_RESULT_LIMIT", originalWebSearchResultLimit],
    ["QUORUM_SEARXNG_BASE_URL", originalSearxngBaseUrl],
    ["QUORUM_EXA_SEARCH_API_KEY", originalExaSearchApiKey],
    [
      "QUORUM_PERPLEXITY_SEARCH_API_KEY",
      originalPerplexitySearchApiKey,
    ],
    ["QUORUM_TAVILY_SEARCH_API_KEY", originalTavilySearchApiKey],
    ["QUORUM_BRAVE_SEARCH_API_KEY", originalBraveSearchApiKey],
    ["QUORUM_FIRECRAWL_SEARCH_API_KEY", originalFirecrawlSearchApiKey],
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

  it("keeps the prompt compiler separate from the default answer model", () => {
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
        name: "qwen3.5:9b",
        specialties: [],
        contextWindow: 16_384,
        qualityRating: 75,
        reasoningEffort: "none",
      }),
    ]);
    expect(config.local.promptAnalyzer).toEqual({
      name: "qwen3.5:2b",
      contextWindow: 4_096,
    });
    expect(config.local.warmOnStartup).toBe(true);
  });

  it("registers answer specialists only when explicitly configured", () => {
    process.env["QUORUM_LOCAL_CODING_MODEL"] = "coding-candidate";
    process.env["QUORUM_LOCAL_REASONING_MODEL"] = "reasoning-candidate";

    expect(loadConfig().local.models).toEqual([
      expect.objectContaining({
        role: "general",
        name: "qwen3.5:9b",
      }),
      expect.objectContaining({
        role: "coding",
        name: "coding-candidate",
        specialties: ["coding"],
      }),
      expect.objectContaining({
        role: "reasoning",
        name: "reasoning-candidate",
        specialties: ["reasoning"],
      }),
    ]);
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

  it("configures a loopback SearXNG search provider", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "searxng";
    process.env["QUORUM_SEARXNG_BASE_URL"] = "http://127.0.0.1:8080";

    expect(loadConfig().webSearch).toEqual({
      enabled: true,
      provider: "searxng",
      resultLimit: 5,
      searxngBaseUrl: "http://127.0.0.1:8080",
      apiKeys: {},
    });
  });

  it("rejects a remote HTTPS SearXNG endpoint", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "searxng";
    process.env["QUORUM_SEARXNG_BASE_URL"] = "https://search.example.com";

    expect(() => loadConfig()).toThrow("explicit loopback hostname");
  });

  it("rejects plaintext remote SearXNG endpoints", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "searxng";
    process.env["QUORUM_SEARXNG_BASE_URL"] = "http://search.example.com";

    expect(() => loadConfig()).toThrow("explicit loopback hostname");
  });

  it("configures Brave Search only when its API key is present", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "brave";
    process.env["QUORUM_BRAVE_SEARCH_API_KEY"] = "search-key";

    expect(loadConfig().webSearch).toEqual({
      enabled: true,
      provider: "brave",
      resultLimit: 5,
      apiKeys: {
        brave: "search-key",
      },
    });
  });

  it("enables keyless Auto search by default and bounds its result count", () => {
    delete process.env["QUORUM_WEB_SEARCH_PROVIDER"];
    delete process.env["QUORUM_WEB_SEARCH_RESULT_LIMIT"];

    expect(loadConfig().webSearch).toEqual({
      enabled: true,
      provider: "auto",
      resultLimit: 5,
      apiKeys: {},
    });

    process.env["QUORUM_WEB_SEARCH_RESULT_LIMIT"] = "500";
    expect(loadConfig().webSearch?.resultLimit).toBe(10);
    process.env["QUORUM_WEB_SEARCH_RESULT_LIMIT"] = "1";
    expect(loadConfig().webSearch?.resultLimit).toBe(3);
  });

  it("requires credentials when a keyed provider is explicitly selected", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "exa";
    delete process.env["QUORUM_EXA_SEARCH_API_KEY"];

    expect(() => loadConfig()).toThrow(
      "An API key is required when exa web search is selected.",
    );
  });

  it("allows search to be disabled with an incomplete selected provider", () => {
    process.env["QUORUM_WEB_SEARCH_ENABLED"] = "false";
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "exa";
    delete process.env["QUORUM_EXA_SEARCH_API_KEY"];

    expect(loadConfig().webSearch).toMatchObject({
      enabled: false,
      provider: "exa",
    });
  });

  it("refuses a non-loopback API binding without authenticated deployment mode", () => {
    process.env["HOST"] = "0.0.0.0";

    expect(() => loadConfig()).toThrow("HOST must be an explicit loopback");
  });

  it("rejects an unknown web-search provider", () => {
    process.env["QUORUM_WEB_SEARCH_PROVIDER"] = "mystery";

    expect(() => loadConfig()).toThrow(
      "QUORUM_WEB_SEARCH_PROVIDER must be one of",
    );
  });
});
