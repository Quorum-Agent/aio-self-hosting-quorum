import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { config as loadEnvironment } from "dotenv";

import {
  loadConfig,
  PROJECT_ROOT,
} from "./config.js";
import { InferenceScheduler } from "./inference-scheduler.js";
import {
  startManagedLlamaRuntime,
  withManagedLlamaEndpoint,
} from "./managed-llama-runtime.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";
import { LocalPromptAnalyzer } from "./prompt-analyzer.js";
import { createRuntime } from "./runtime.js";

loadEnvironment({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

async function collectProviderAnswer(
  provider: OpenAICompatibleProvider,
  prompt: string,
): Promise<{ content: string; elapsedMs: number }> {
  const now = new Date().toISOString();
  const message = {
    id: randomUUID(),
    role: "user" as const,
    content: prompt,
    createdAt: now,
  };
  const request = {
    id: randomUUID(),
    conversationId: "managed-llama-evaluation",
    messages: [message],
    prompt,
    policy: "private" as const,
    verbosity: "concise" as const,
    analysis: {
      source: "heuristic" as const,
      intent: "conversation" as const,
      confidence: 1,
      taskSummary: prompt,
    },
    requirements: {
      intent: "conversation" as const,
      intentConfidence: 1,
      intentSource: "current" as const,
      capabilities: ["chat" as const],
      requiresFreshness: false,
      containsSensitiveData: false,
      sensitiveDataCategories: [],
      containsWebGroundedData: false,
    },
  };
  const startedAt = performance.now();
  let content = "";
  for await (const chunk of provider.stream({
    messages: [message],
    request,
    runtimeModels: [provider.model],
    runtimeTools: [],
  })) {
    content += chunk;
  }
  return { content, elapsedMs: elapsedMs(startedAt) };
}

async function verifyCancellation(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<{ observed: boolean; elapsedMs: number }> {
  const controller = new AbortController();
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({
      model: options.model,
      messages: [
        {
          role: "user",
          content:
            "Write a very long numbered explanation with at least 1000 entries.",
        },
      ],
      stream: true,
      max_tokens: 2048,
    }),
    signal: controller.signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Cancellation probe returned ${response.status}.`);
  }
  const reader = response.body.getReader();
  await reader.read();
  const startedAt = performance.now();
  controller.abort();
  let observed = false;
  try {
    await reader.read();
  } catch (error) {
    observed =
      error instanceof Error &&
      (error.name === "AbortError" || /abort/i.test(error.message));
  }
  return { observed, elapsedMs: elapsedMs(startedAt) };
}

async function endpointUnavailable(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/health`, {
      signal: AbortSignal.timeout(1_000),
      redirect: "error",
    });
    return false;
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const initialConfig = loadConfig();
  if (!initialConfig.managedLlama) {
    throw new Error(
      "Set QUORUM_MANAGED_LLAMA_SERVER and QUORUM_MANAGED_LLAMA_MODELS before running the evaluation.",
    );
  }
  const startupAt = performance.now();
  const managed = await startManagedLlamaRuntime(
    initialConfig.managedLlama,
    initialConfig.dataDirectory,
  );
  let stopped = false;

  try {
    const config = withManagedLlamaEndpoint(initialConfig, managed);
    const quorumRuntime = await createRuntime({
      ...config,
      local: { ...config.local, warmOnStartup: false },
    });
    const origin = managed.baseUrl.replace(/\/v1$/, "");
    const unauthenticatedCatalog = await fetch(`${managed.baseUrl}/models`, {
      redirect: "error",
    });
    const unauthenticatedGeneration = await fetch(
      `${managed.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: config.local.models[0]?.name,
          messages: [{ role: "user", content: "Reply OK." }],
          max_tokens: 1,
        }),
        redirect: "error",
      },
    );
    const catalogResponse = await fetch(`${origin}/models`, {
      headers: { authorization: `Bearer ${managed.apiKey}` },
      redirect: "error",
    });
    if (!catalogResponse.ok) {
      throw new Error(`Managed model catalog returned ${catalogResponse.status}.`);
    }
    const scheduler = new InferenceScheduler();
    const analyzer = new LocalPromptAnalyzer({
      id: `local:classifier:${config.local.promptAnalyzer.name}`,
      label: config.local.promptAnalyzer.name,
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKey,
      model: config.local.promptAnalyzer.name,
      contextWindow: config.local.promptAnalyzer.contextWindow,
      nativeOllama: false,
      scheduler,
    });
    const analysisAt = performance.now();
    const analysis = await analyzer.analyze({
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: "How do I build a Docker image?",
          createdAt: new Date().toISOString(),
        },
      ],
      baseline: {
        source: "heuristic",
        intent: "coding",
        confidence: 0.99,
        taskSummary: "Explain how to build a Docker image.",
      },
      baselineIntentSource: "current",
    });
    const analysisElapsedMs = elapsedMs(analysisAt);
    const general = config.local.models.find(
      (model) => model.role === "general",
    );
    if (!general) throw new Error("No general model is configured.");
    const provider = new OpenAICompatibleProvider({
      id: `local:general:${general.name}`,
      label: general.name,
      provider: "llama.cpp",
      role: "general",
      location: "local",
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKey,
      model: general.name,
      contextWindow: general.contextWindow,
      qualityRating: general.qualityRating,
      capabilities: general.capabilities,
      specialties: general.specialties,
      maxOutputTokens: 128,
      nativeOllama: false,
      scheduler,
      timeouts: {
        firstTokenMs: 60_000,
        idleMs: 30_000,
        validatedOutputMs: 90_000,
        totalMs: 120_000,
      },
    });
    const first = await collectProviderAnswer(
      provider,
      "Reply with one short sentence confirming the managed runtime is ready.",
    );
    const second = await collectProviderAnswer(
      provider,
      "Reply with one short sentence confirming the managed runtime is still warm.",
    );
    const cancellation = await verifyCancellation({
      baseUrl: managed.baseUrl,
      apiKey: managed.apiKey,
      model: general.name,
    });
    const pid = managed.pid;
    const modelIds = [...managed.modelIds];
    const rawCatalog = (await catalogResponse.json()) as {
      data?: Array<{
        id?: string;
        status?: { value?: string };
        architecture?: {
          input_modalities?: string[];
          output_modalities?: string[];
        };
        meta?: {
          n_ctx?: number;
          n_params?: number;
          size?: number;
          ftype?: string;
        };
      }>;
    };
    const catalog = {
      models: (rawCatalog.data ?? [])
        .filter(
          (entry) =>
            typeof entry.id === "string" &&
            managed.modelIds.includes(entry.id),
        )
        .map((entry) => ({
          id: entry.id,
          status: entry.status?.value,
          architecture: entry.architecture,
          meta: entry.meta,
        })),
    };
    const baseUrl = managed.baseUrl;
    await managed.stop();
    stopped = true;
    const shutdownClean = await endpointUnavailable(origin);
    const report = {
      generatedAt: new Date().toISOString(),
      runtime: {
        pid,
        baseUrl,
        modelIds,
        startupMs: elapsedMs(startupAt),
        unauthenticatedCatalogStatus: unauthenticatedCatalog.status,
        unauthenticatedGenerationStatus: unauthenticatedGeneration.status,
      },
      catalog,
      promptAnalyzer: {
        result: analysis,
        elapsedMs: analysisElapsedMs,
      },
      quorumRuntime: quorumRuntime.localRuntime,
      mainModel: {
        first,
        second,
      },
      cancellation,
      shutdownClean,
      passed:
        unauthenticatedGeneration.status === 401 &&
        quorumRuntime.localRuntime.state === "ready" &&
        analysis.intent === "coding" &&
        first.content.trim().length > 0 &&
        second.content.trim().length > 0 &&
        cancellation.observed &&
        shutdownClean,
    };
    const reportPath = resolve(
      process.env["QUORUM_MANAGED_LLAMA_REPORT"] ??
        "./var/managed-llama-runtime/evaluation.json",
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (!stopped) await managed.stop();
  }
}

await main();
