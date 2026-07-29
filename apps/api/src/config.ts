import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Capability } from "@quorum/core";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveFromProjectRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export interface LocalModelConfig {
  name: string;
  capabilities: Capability[];
  specialties: Capability[];
  contextWindow: number;
  qualityRating: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
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

function mergeLocalModels(models: LocalModelConfig[]): LocalModelConfig[] {
  const merged = new Map<string, LocalModelConfig>();

  for (const model of models) {
    const existing = merged.get(model.name);
    if (!existing) {
      merged.set(model.name, model);
      continue;
    }

    const reasoningEffort =
      model.reasoningEffort ?? existing.reasoningEffort;
    merged.set(model.name, {
      name: model.name,
      capabilities: [...new Set([...existing.capabilities, ...model.capabilities])],
      specialties: [...new Set([...existing.specialties, ...model.specialties])],
      contextWindow: Math.max(existing.contextWindow, model.contextWindow),
      qualityRating: Math.max(existing.qualityRating, model.qualityRating),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }

  return [...merged.values()];
}

export function loadConfig(): AppConfig {
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();
  const primaryModel = process.env["QUORUM_LOCAL_MODEL"] ?? "qwen3:4b";
  const localModels = mergeLocalModels([
    {
      name: primaryModel,
      capabilities: ["chat", "reasoning", "coding", "documents"],
      specialties: [],
      contextWindow: 32_000,
      qualityRating: 60,
    },
    {
      name:
        process.env["QUORUM_LOCAL_CODING_MODEL"] ??
        "qwen2.5-coder:1.5b",
      capabilities: ["chat", "coding"],
      specialties: ["coding"],
      contextWindow: 32_000,
      qualityRating: 50,
    },
    {
      name:
        process.env["QUORUM_LOCAL_REASONING_MODEL"] ??
        "qwen3.5:2b",
      capabilities: ["chat", "reasoning"],
      specialties: ["reasoning"],
      contextWindow: 256_000,
      qualityRating: 55,
      reasoningEffort: "none",
    },
  ]);

  return {
    host: process.env["HOST"] ?? "127.0.0.1",
    port: Number(process.env["PORT"] ?? 8787),
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    dataDirectory: resolveFromProjectRoot(process.env["QUORUM_DATA_DIR"] ?? "./var"),
    local: {
      baseUrl: (process.env["QUORUM_LOCAL_BASE_URL"] ?? "http://127.0.0.1:11434/v1").replace(
        /\/$/,
        "",
      ),
      apiKey: process.env["QUORUM_LOCAL_API_KEY"] ?? "ollama",
      models: localModels,
    },
    ...(cloudApiKey
      ? {
          cloud: {
            baseUrl: (process.env["QUORUM_CLOUD_BASE_URL"] ?? "https://api.openai.com/v1").replace(
              /\/$/,
              "",
            ),
            model: process.env["QUORUM_CLOUD_MODEL"] ?? "gpt-4.1-mini",
            apiKey: cloudApiKey,
          },
        }
      : {}),
  };
}
