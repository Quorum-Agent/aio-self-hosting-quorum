import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Capability, LocalModelRole } from "@quorum/core";

import {
  normalizeCloudBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./loopback-url.js";

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

export type WebSearchConfig =
  | {
      provider: "searxng";
      baseUrl: string;
    }
  | {
      provider: "brave";
      apiKey: string;
    };

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
  };
  webSearch?: WebSearchConfig;
}

export function loadConfig(): AppConfig {
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();
  const configuredWebProvider =
    process.env["QUORUM_WEB_SEARCH_PROVIDER"]?.trim().toLowerCase();
  const searxngBaseUrl = process.env["QUORUM_SEARXNG_BASE_URL"]?.trim();
  const braveSearchApiKey =
    process.env["QUORUM_BRAVE_SEARCH_API_KEY"]?.trim();
  const webProvider =
    configuredWebProvider ||
    (searxngBaseUrl ? "searxng" : braveSearchApiKey ? "brave" : undefined);
  if (
    webProvider !== undefined &&
    webProvider !== "searxng" &&
    webProvider !== "brave"
  ) {
    throw new Error(
      "QUORUM_WEB_SEARCH_PROVIDER must be either searxng or brave.",
    );
  }
  let webSearch: WebSearchConfig | undefined;
  if (webProvider === "searxng") {
    if (!searxngBaseUrl) {
      throw new Error(
        "QUORUM_SEARXNG_BASE_URL is required when SearXNG web search is enabled.",
      );
    }
    webSearch = {
      provider: "searxng",
      baseUrl: normalizeLoopbackBaseUrl(
        searxngBaseUrl,
        "QUORUM_SEARXNG_BASE_URL",
      ),
    };
  } else if (webProvider === "brave") {
    if (!braveSearchApiKey) {
      throw new Error(
        "QUORUM_BRAVE_SEARCH_API_KEY is required when Brave web search is enabled.",
      );
    }
    webSearch = {
      provider: "brave",
      apiKey: braveSearchApiKey,
    };
  }
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
    host: process.env["HOST"] ?? "127.0.0.1",
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
          },
        }
      : {}),
    ...(webSearch ? { webSearch } : {}),
  };
}
