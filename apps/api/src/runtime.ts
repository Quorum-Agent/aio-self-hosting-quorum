import {
  DemoProvider,
  Orchestrator,
  type LocalRuntimeStatus,
  type ModelProvider,
} from "@quorum/core";

import type { AppConfig } from "./config.js";
import { InferenceScheduler } from "./inference-scheduler.js";
import {
  discoverModels,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";

export interface QuorumRuntime {
  orchestrator: Orchestrator;
  localRuntime: LocalRuntimeStatus;
  cloudConfigured: boolean;
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
      : roles.every((role) => role.available)
        ? "ready"
        : "degraded",
    endpointConnected,
    roles,
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
    state: !discovered.endpointConnected
      ? "unavailable"
      : roles.every((role) => role.available)
        ? "ready"
        : "degraded",
  };
}

export async function createRuntime(config: AppConfig): Promise<QuorumRuntime> {
  const localDiscovery = await discoverModels(
    config.local.baseUrl,
    config.local.apiKey,
  );
  const providers = createLocalProviders(
    config,
    localDiscovery.connected ? localDiscovery.modelIds : [],
  );
  const localRuntime = describeLocalRuntime(
    config,
    localDiscovery.connected,
    providers,
  );

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
  const orchestrator = new Orchestrator(providers);

  return {
    orchestrator,
    get localRuntime() {
      return currentLocalRuntime(localRuntime, orchestrator.models);
    },
    cloudConfigured: Boolean(config.cloud),
  };
}
