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
  };
  cloud?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

export function loadConfig(): AppConfig {
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();
  const primaryModel = process.env["QUORUM_LOCAL_MODEL"] ?? "qwen3:4b";
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
      qualityRating: 60,
    },
    {
      role: "coding",
      name:
        process.env["QUORUM_LOCAL_CODING_MODEL"] ??
        "qwen2.5-coder:1.5b",
      capabilities: ["chat", "coding"],
      specialties: ["coding"],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_CODING_CONTEXT_WINDOW"],
        16_384,
      ),
      qualityRating: 50,
    },
    {
      role: "reasoning",
      name:
        process.env["QUORUM_LOCAL_REASONING_MODEL"] ??
        "qwen3.5:2b",
      capabilities: ["chat", "reasoning"],
      specialties: ["reasoning"],
      contextWindow: positiveInteger(
        process.env["QUORUM_LOCAL_REASONING_CONTEXT_WINDOW"],
        16_384,
      ),
      qualityRating: 55,
      reasoningEffort: "none",
    },
  ];

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
  };
}
