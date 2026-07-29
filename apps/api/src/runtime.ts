import {
  DemoProvider,
  Orchestrator,
  type LocalRuntimeStatus,
  type ModelProvider,
} from "@quorum/core";

import type { AppConfig } from "./config.js";
import { InferenceScheduler } from "./inference-scheduler.js";
import { warmLocalModel } from "./model-warmup.js";
import {
  discoverModels,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";
import { LocalPromptAnalyzer } from "./prompt-analyzer.js";

export interface ModelWarmupStatus {
  state: "disabled" | "idle" | "warming" | "ready" | "degraded";
  models: Array<{
    model: string;
    role: "classifier" | "general";
    status: "pending" | "warming" | "ready" | "failed";
    detail?: string;
  }>;
}

export interface QuorumRuntime {
  orchestrator: Orchestrator;
  localRuntime: LocalRuntimeStatus;
  cloudConfigured: boolean;
  warmup: Promise<ModelWarmupStatus>;
  warmupStatus: ModelWarmupStatus;
}

export function createLocalProviders(
  config: AppConfig,
  installedModelIds: string[],
  scheduler = new InferenceScheduler(),
): ModelProvider[] {
  return config.local.models
    .filter((model) => installedModelIds.includes(model.name))
    .map(
      (model) =>
        new OpenAICompatibleProvider({
          id: `local:${model.role}:${model.name}`,
          label: model.name,
          provider: "openai-compatible",
          role: model.role,
          location: "local",
          baseUrl: config.local.baseUrl,
          apiKey: config.local.apiKey,
          model: model.name,
          contextWindow: model.contextWindow,
          qualityRating: model.qualityRating,
          capabilities: model.capabilities,
          specialties: model.specialties,
          nativeOllama: true,
          ...(model.reasoningEffort
            ? { reasoningEffort: model.reasoningEffort }
            : {}),
          scheduler,
        }),
    );
}

export function describeLocalRuntime(
  config: AppConfig,
  endpointConnected: boolean,
  providers: ModelProvider[],
  promptAnalyzerAvailable: boolean,
): LocalRuntimeStatus {
  const providerIds = new Set(providers.map((provider) => provider.model.id));
  const roles = config.local.models.map((model) => {
    const modelId = `local:${model.role}:${model.name}`;
    return {
      role: model.role,
      configuredModel: model.name,
      modelId,
      required: model.role === "general",
      available: providerIds.has(modelId),
    };
  });

  return {
    state: !endpointConnected
      ? "unavailable"
      : roles.every((role) => role.available) && promptAnalyzerAvailable
        ? "ready"
        : "degraded",
    endpointConnected,
    roles,
    promptAnalyzer: {
      configuredModel: config.local.promptAnalyzer.name,
      modelId: `local:classifier:${config.local.promptAnalyzer.name}`,
      available: promptAnalyzerAvailable,
    },
  };
}

export function currentLocalRuntime(
  discovered: LocalRuntimeStatus,
  models: ModelProvider["model"][],
): LocalRuntimeStatus {
  const availability = new Map(
    models.map((model) => [model.id, model.available]),
  );
  const roles = discovered.roles.map((role) => ({
    ...role,
    available: role.modelId
      ? availability.get(role.modelId) === true
      : false,
  }));
  return {
    endpointConnected: discovered.endpointConnected,
    roles,
    ...(discovered.promptAnalyzer
      ? { promptAnalyzer: discovered.promptAnalyzer }
      : {}),
    state: !discovered.endpointConnected
      ? "unavailable"
      : roles.every((role) => role.available) &&
          discovered.promptAnalyzer?.available !== false
        ? "ready"
        : "degraded",
  };
}

export async function createRuntime(config: AppConfig): Promise<QuorumRuntime> {
  const scheduler = new InferenceScheduler();
  const localDiscovery = await discoverModels(
    config.local.baseUrl,
    config.local.apiKey,
  );
  const providers = createLocalProviders(
    config,
    localDiscovery.connected ? localDiscovery.modelIds : [],
    scheduler,
  );
  const promptAnalyzerAvailable =
    localDiscovery.connected &&
    localDiscovery.modelIds.includes(config.local.promptAnalyzer.name);
  const localRuntime = describeLocalRuntime(
    config,
    localDiscovery.connected,
    providers,
    promptAnalyzerAvailable,
  );
  const promptAnalyzer = promptAnalyzerAvailable
    ? new LocalPromptAnalyzer({
        id: `local:classifier:${config.local.promptAnalyzer.name}`,
        label: config.local.promptAnalyzer.name,
        baseUrl: config.local.baseUrl,
        apiKey: config.local.apiKey,
        model: config.local.promptAnalyzer.name,
        contextWindow: config.local.promptAnalyzer.contextWindow,
        scheduler,
      })
    : undefined;

  if (config.cloud) {
    providers.push(
      new OpenAICompatibleProvider({
        id: `cloud:${config.cloud.model}`,
        label: config.cloud.model,
        provider: "openai-compatible",
        location: "cloud",
        baseUrl: config.cloud.baseUrl,
        apiKey: config.cloud.apiKey,
        model: config.cloud.model,
        contextWindow: 128_000,
        qualityRating: 90,
        capabilities: ["chat", "reasoning", "coding", "documents"],
      }),
    );
  }

  providers.push(new DemoProvider());
  const orchestrator = new Orchestrator(
    providers,
    undefined,
    undefined,
    promptAnalyzer,
  );
  const generalModel = config.local.models.find(
    (model) =>
      model.role === "general" &&
      localDiscovery.modelIds.includes(model.name),
  );
  const warmupStatus: ModelWarmupStatus = {
    state: config.local.warmOnStartup
      ? promptAnalyzer || generalModel
        ? "warming"
        : "idle"
      : "disabled",
    models: [
      ...(promptAnalyzer
        ? [
            {
              model: config.local.promptAnalyzer.name,
              role: "classifier" as const,
              status: "pending" as const,
            },
          ]
        : []),
      ...(generalModel
        ? [
            {
              model: generalModel.name,
              role: "general" as const,
              status: "pending" as const,
            },
          ]
        : []),
    ],
  };
  const warmup = (async (): Promise<ModelWarmupStatus> => {
    if (!config.local.warmOnStartup || warmupStatus.models.length === 0) {
      return warmupStatus;
    }

    for (const target of warmupStatus.models) {
      target.status = "warming";
      try {
        await warmLocalModel({
          baseUrl: config.local.baseUrl,
          apiKey: config.local.apiKey,
          model: target.model,
          scheduler,
        });
        target.status = "ready";
      } catch (error) {
        target.status = "failed";
        target.detail =
          error instanceof Error ? error.message : "Model warmup failed.";
      }
    }
    warmupStatus.state = warmupStatus.models.some(
      (target) => target.status === "failed",
    )
      ? "degraded"
      : "ready";
    return warmupStatus;
  })();

  return {
    orchestrator,
    get localRuntime() {
      return currentLocalRuntime(localRuntime, orchestrator.models);
    },
    cloudConfigured: Boolean(config.cloud),
    warmup,
    get warmupStatus() {
      return warmupStatus;
    },
  };
}
