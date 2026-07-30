import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Capability, LocalModelRole } from "@quorum/core";

import {
  normalizeCloudBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./loopback-url.js";
import {
  isLoopbackHostname,
  normalizeSearchBaseUrl,
} from "./outbound-url.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveFromProjectRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export interface LocalModelConfig {
  role: LocalModelRole;
  name: string;
  capabilities: Capability[];
  specialties: Capability[];
  contextWindow: number;
  qualityRating: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

export interface PromptAnalyzerConfig {
  name: string;
  contextWindow: number;
}

export const WEB_SEARCH_PROVIDER_IDS = [
  "auto",
  "duckduckgo",
  "exa",
  "perplexity",
  "tavily",
  "brave",
  "firecrawl",
  "searxng",
] as const;

export type WebSearchProviderId =
  (typeof WEB_SEARCH_PROVIDER_IDS)[number];

export type KeyedWebSearchProviderId =
  | "exa"
  | "perplexity"
  | "tavily"
  | "brave"
  | "firecrawl";

export interface WebSearchConfig {
  enabled: boolean;
  provider: WebSearchProviderId;
  resultLimit: number;
  searxngBaseUrl?: string;
  apiKeys: Partial<Record<KeyedWebSearchProviderId, string>>;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  dataDirectory: string;
  local: {
    baseUrl: string;
    apiKey: string;
    models: LocalModelConfig[];
    promptAnalyzer: PromptAnalyzerConfig;
    warmOnStartup: boolean;
  };
  cloud?: {
    baseUrl: string;
    model: string;
    apiKey: string;
    contextWindow: number;
    qualityRating: number;
  };
  webSearch?: WebSearchConfig;
}

export function loadConfig(): AppConfig {
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (!isLoopbackHostname(host)) {
    throw new Error(
      "HOST must be an explicit loopback address until authenticated remote access is available.",
    );
  }
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();
  const configuredWebProvider =
    process.env["QUORUM_WEB_SEARCH_PROVIDER"]?.trim().toLowerCase();
  const searxngBaseUrl = process.env["QUORUM_SEARXNG_BASE_URL"]?.trim();
  const apiKeys: WebSearchConfig["apiKeys"] = {};
  const configuredApiKeys: Array<
    [KeyedWebSearchProviderId, string | undefined]
  > = [
    ["exa", process.env["QUORUM_EXA_SEARCH_API_KEY"]?.trim()],
    [
      "perplexity",
      process.env["QUORUM_PERPLEXITY_SEARCH_API_KEY"]?.trim(),
    ],
    ["tavily", process.env["QUORUM_TAVILY_SEARCH_API_KEY"]?.trim()],
    ["brave", process.env["QUORUM_BRAVE_SEARCH_API_KEY"]?.trim()],
    ["firecrawl", process.env["QUORUM_FIRECRAWL_SEARCH_API_KEY"]?.trim()],
  ];
  for (const [provider, apiKey] of configuredApiKeys) {
    if (apiKey) apiKeys[provider] = apiKey;
  }
  if (
    configuredWebProvider !== undefined &&
    !WEB_SEARCH_PROVIDER_IDS.includes(
      configuredWebProvider as WebSearchProviderId,
    )
  ) {
    throw new Error(
      `QUORUM_WEB_SEARCH_PROVIDER must be one of: ${WEB_SEARCH_PROVIDER_IDS.join(", ")}.`,
    );
  }
  const webProvider =
    (configuredWebProvider as WebSearchProviderId | undefined) ?? "auto";
  const webSearchEnabled =
    process.env["QUORUM_WEB_SEARCH_ENABLED"]?.trim().toLowerCase() !== "false";
  if (webSearchEnabled && webProvider === "searxng" && !searxngBaseUrl) {
    throw new Error(
      "QUORUM_SEARXNG_BASE_URL is required when SearXNG web search is enabled.",
    );
  }
  if (
    webSearchEnabled &&
    webProvider !== "auto" &&
    webProvider !== "duckduckgo" &&
    webProvider !== "searxng" &&
    !apiKeys[webProvider]
  ) {
    throw new Error(
      `An API key is required when ${webProvider} web search is selected.`,
    );
  }
  let normalizedSearxngBaseUrl: string | undefined;
  if (searxngBaseUrl) {
    normalizedSearxngBaseUrl = normalizeSearchBaseUrl(
      searxngBaseUrl,
      "QUORUM_SEARXNG_BASE_URL",
    );
  }
  const webSearch: WebSearchConfig = {
    enabled: webSearchEnabled,
    provider: webProvider,
    resultLimit: Math.max(
      3,
      Math.min(
        positiveInteger(process.env["QUORUM_WEB_SEARCH_RESULT_LIMIT"], 5),
        10,
      ),
    ),
    apiKeys,
    ...(normalizedSearxngBaseUrl
      ? { searxngBaseUrl: normalizedSearxngBaseUrl }
      : {}),
  };
  const primaryModel = process.env["QUORUM_LOCAL_MODEL"] ?? "qwen3.5:9b";
  const codingModel = process.env["QUORUM_LOCAL_CODING_MODEL"]?.trim();
  const reasoningModel = process.env["QUORUM_LOCAL_REASONING_MODEL"]?.trim();
  const localModels: LocalModelConfig[] = [
    {
      role: "general",
      name: primaryModel,
      capabilities: ["chat", "reasoning", "coding", "documents"],
      specialties: [],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_CONTEXT_WINDOW"],
        16_384,
      ),
      qualityRating: 75,
      reasoningEffort: "none",
    },
  ];
  if (codingModel) {
    localModels.push({
      role: "coding",
      name: codingModel,
      capabilities: ["chat", "coding"],
      specialties: ["coding"],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_CODING_CONTEXT_WINDOW"],
        16_384,
      ),
      qualityRating: 65,
    });
  }
  if (reasoningModel) {
    localModels.push({
      role: "reasoning",
      name: reasoningModel,
      capabilities: ["chat", "reasoning"],
      specialties: ["reasoning"],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_REASONING_CONTEXT_WINDOW"],
        16_384,
      ),
      qualityRating: 65,
      reasoningEffort: "none",
    });
  }

  return {
    host,
    port: Number(process.env["PORT"] ?? 8787),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    dataDirectory: resolveFromProjectRoot(process.env["QUORUM_DATA_DIR"] ?? "./var"),
    local: {
      baseUrl: normalizeLoopbackBaseUrl(
        process.env["QUORUM_LOCAL_BASE_URL"] ??
          "http://127.0.0.1:11434/v1",
      ),
      apiKey: process.env["QUORUM_LOCAL_API_KEY"] ?? "ollama",
      models: localModels,
      promptAnalyzer: {
        name:
          process.env["QUORUM_LOCAL_PROMPT_MODEL"] ??
          "qwen3.5:2b",
        contextWindow: positiveInteger(
          process.env["QUORUM_LOCAL_PROMPT_CONTEXT_WINDOW"],
          4_096,
        ),
      },
      warmOnStartup:
        process.env["QUORUM_LOCAL_WARMUP"]?.trim().toLowerCase() !== "false",
    },
    ...(cloudApiKey
      ? {
          cloud: {
            baseUrl: normalizeCloudBaseUrl(
              process.env["QUORUM_CLOUD_BASE_URL"] ??
                "https://api.openai.com/v1",
            ),
            model: process.env["QUORUM_CLOUD_MODEL"] ?? "gpt-4.1-mini",
            apiKey: cloudApiKey,
            contextWindow: positiveInteger(
              process.env["QUORUM_CLOUD_CONTEXT_WINDOW"],
              128_000,
            ),
            qualityRating: Math.min(
              100,
              positiveInteger(
                process.env["QUORUM_CLOUD_QUALITY_RATING"],
                80,
              ),
            ),
          },
        }
      : {}),
    webSearch,
  };
}
