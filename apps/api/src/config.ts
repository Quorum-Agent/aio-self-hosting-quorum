import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function resolveFromProjectRoot(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  dataDirectory: string;
  local: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
  cloud?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
}

export function loadConfig(): AppConfig {
  const cloudApiKey = process.env["QUORUM_CLOUD_API_KEY"]?.trim();

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
      model: process.env["QUORUM_LOCAL_MODEL"] ?? "qwen3:4b",
      apiKey: process.env["QUORUM_LOCAL_API_KEY"] ?? "ollama",
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
