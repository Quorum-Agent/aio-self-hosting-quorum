import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Capability,
  LocalModelRole,
  OrchestrationMode,
} from "@quorum/core";

import {
  normalizeCloudBaseUrl,
  normalizeNetworkBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./loopback-url.js";
import {
  isLoopbackHostname,
  normalizeSearchBaseUrl,
} from "./outbound-url.js";
import { readSlotSettings } from "./slot-settings.js";

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

export interface ManagedLlamaConfig {
  executablePath: string;
  manifestPath: string;
  startupTimeoutMs: number;
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

const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ["route", "relay"];

function isOrchestrationMode(value: string): value is OrchestrationMode {
  return (ORCHESTRATION_MODES as readonly string[]).includes(value);
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
  quorumLocalApiKey?: string;
  local: {
    apiBase: string;
    downloadBase?: string;
    apiKey: string;
    transport: "ollama" | "openai-compatible";
    models: LocalModelConfig[];
    promptAnalyzer: PromptAnalyzerConfig;
    warmOnStartup: boolean;
  };
  managedLlama?: ManagedLlamaConfig;
  cloud?: {
    apiBase: string;
    downloadBase?: string;
    model: string;
    apiKey: string;
    contextWindow: number;
    qualityRating: number;
  };
  /**
   * A model hosted on the operator's own network — another machine they run.
   *
   * Distinct from `cloud` because the tiers are distinct: this leaves the
   * device but not the network, and the operator controls the stack at both
   * ends. Configured by hand; discovery and pairing are deliberately not built.
   */
  network?: {
    apiBase: string;
    downloadBase?: string;
    model: string;
    apiKey: string;
    contextWindow: number;
    qualityRating: number;
  };
  webSearch?: WebSearchConfig;
  // Optional so partial fixtures stay focused, matching webSearch above.
  // loadConfig always sets it; consumers default to "route".
  orchestrationMode?: OrchestrationMode;
}

export function loadConfig(): AppConfig {
  const host = process.env["HOST"] ?? "127.0.0.1";
  if (!isLoopbackHostname(host)) {
    throw new Error(
      "HOST must be an explicit loopback address until authenticated remote access is available.",
    );
  }
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();
  const networkApiKey = process.env["QUORUM_NETWORK_API_KEY"]?.trim();
  const configuredLocalTransport =
    process.env["QUORUM_LOCAL_TRANSPORT"]?.trim().toLowerCase() ?? "ollama";
  if (
    configuredLocalTransport !== "ollama" &&
    configuredLocalTransport !== "openai-compatible"
  ) {
    throw new Error(
      "QUORUM_LOCAL_TRANSPORT must be ollama or openai-compatible.",
    );
  }
  const configuredOrchestrationMode =
    process.env["QUORUM_ORCHESTRATION_MODE"]?.trim().toLowerCase() ?? "route";
  if (!isOrchestrationMode(configuredOrchestrationMode)) {
    throw new Error(
      `QUORUM_ORCHESTRATION_MODE must be one of ${ORCHESTRATION_MODES.join(", ")}.`,
    );
  }
  const managedLlamaExecutable =
    process.env["QUORUM_MANAGED_LLAMA_SERVER"]?.trim();
  const managedLlamaManifest =
    process.env["QUORUM_MANAGED_LLAMA_MODELS"]?.trim();
  if (Boolean(managedLlamaExecutable) !== Boolean(managedLlamaManifest)) {
    throw new Error(
      "QUORUM_MANAGED_LLAMA_SERVER and QUORUM_MANAGED_LLAMA_MODELS must be configured together.",
    );
  }
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
  const dataDirectory = resolveFromProjectRoot(
    process.env["QUORUM_DATA_DIR"] ?? "./var",
  );
  const quorumLocalApiKey = process.env["QUORUM_LOCAL_API_KEY"]?.trim();
  // Operator-saved slot assignments, consulted only where the environment is
  // silent. Every `??` below reads left to right as: environment, then saved
  // setting, then built-in default. Reversing any of those pairs would change
  // behaviour for deployments that configure models by environment, which is
  // all of them today, and nothing would appear to fail.
  const storedSlots = readSlotSettings(dataDirectory).slots;
  const primaryModel =
    process.env["QUORUM_LOCAL_MODEL"] ??
    storedSlots.general?.model ??
    "qwen3.5:9b";
  const codingModel =
    process.env["QUORUM_LOCAL_CODING_MODEL"]?.trim() ??
    storedSlots.coding?.model;
  const reasoningModel =
    process.env["QUORUM_LOCAL_REASONING_MODEL"]?.trim() ??
    storedSlots.reasoning?.model;
  const localModels: LocalModelConfig[] = [
    {
      role: "general",
      name: primaryModel,
      capabilities: ["chat", "reasoning", "coding", "documents"],
      specialties: [],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_CONTEXT_WINDOW"],
        storedSlots.general?.contextWindow ?? 16_384,
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
        storedSlots.coding?.contextWindow ?? 16_384,
      ),
      qualityRating: 65,
      // The general and reasoning roles have always set this; the coding role
      // did not, which is backwards — coding specialists are among the most
      // likely to be reasoning models. Measured on llama.cpp b10192: reasoning
      // tokens are drawn from the same budget as the answer, so a thinking
      // model under a tight `max_tokens` returns `finish_reason: "length"`
      // with EMPTY content (0 characters at max_tokens 128, where the same
      // model with reasoning suppressed answered normally). Empty content then
      // fails answer validation, excludes the model, and re-plans.
      reasoningEffort: "none",
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
        storedSlots.reasoning?.contextWindow ?? 16_384,
      ),
      qualityRating: 65,
      reasoningEffort: "none",
    });
  }

  return {
    host,
    port: Number(process.env["PORT"] ?? 8787),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    dataDirectory,
    quorumLocalApiKey,
    local: {
      apiBase: normalizeLoopbackBaseUrl(
        process.env["QUORUM_LOCAL_BASE_URL"] ??
          "http://127.0.0.1:11434/v1",
      ),
      downloadBase: normalizeLoopbackBaseUrl(
        process.env["QUORUM_LOCAL_BASE_URL"] ??
          "http://127.0.0.1:11434/v1",
      ),
      apiKey: process.env["QUORUM_LOCAL_API_KEY"] ?? "ollama",
      transport: configuredLocalTransport,
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
    ...(managedLlamaExecutable && managedLlamaManifest
      ? {
          managedLlama: {
            executablePath: resolveFromProjectRoot(managedLlamaExecutable),
            manifestPath: resolveFromProjectRoot(managedLlamaManifest),
            startupTimeoutMs: positiveInteger(
              process.env["QUORUM_MANAGED_LLAMA_STARTUP_TIMEOUT_MS"],
              180_000,
            ),
          },
        }
      : {}),
    // Absent without credentials, exactly as cloud is. A peer that answers
    // unauthenticated is a peer anyone on the network can impersonate, so
    // there is no anonymous mode: no key, no provider.
    ...(networkApiKey &&
    process.env["QUORUM_NETWORK_BASE_URL"]?.trim() &&
    // A model name is required, not defaulted. Cloud can default to a vendor's
    // catalogue name; a peer's model is whatever that machine happens to
    // serve, so guessing is meaningless. Without this the provider registered
    // with an empty id and a blank label, was planner-selectable, and failed
    // only at request time.
    process.env["QUORUM_NETWORK_MODEL"]?.trim()
      ? {
          network: {
            apiBase: normalizeNetworkBaseUrl(
              process.env["QUORUM_NETWORK_BASE_URL"]!.trim(),
            ),
            downloadBase: normalizeNetworkBaseUrl(
              process.env["QUORUM_NETWORK_BASE_URL"]!.trim(),
            ),
            model: process.env["QUORUM_NETWORK_MODEL"]!.trim(),
            apiKey: networkApiKey,
            contextWindow: positiveInteger(
              process.env["QUORUM_NETWORK_CONTEXT_WINDOW"],
              16_384,
            ),
            qualityRating: Math.min(
              100,
              positiveInteger(process.env["QUORUM_NETWORK_QUALITY_RATING"], 70),
            ),
          },
        }
      : {}),
    ...(cloudApiKey
      ? {
          cloud: {
            apiBase: normalizeCloudBaseUrl(
              process.env["QUORUM_CLOUD_BASE_URL"] ??
                "https://api.openai.com/v1",
            ),
            downloadBase: normalizeCloudBaseUrl(
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
    orchestrationMode: configuredOrchestrationMode,
  };
}
