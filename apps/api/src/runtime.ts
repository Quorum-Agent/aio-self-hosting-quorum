import { DemoProvider, Orchestrator, type ModelProvider } from "@quorum/core";

import type { AppConfig } from "./config.js";
import {
  discoverModels,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";

export interface QuorumRuntime {
  orchestrator: Orchestrator;
  localEndpointConnected: boolean;
  cloudConfigured: boolean;
}

export function createLocalProviders(
  config: AppConfig,
  installedModelIds: string[],
): ModelProvider[] {
  return config.local.models
    .filter((model) => installedModelIds.includes(model.name))
    .map(
      (model) =>
        new OpenAICompatibleProvider({
          id: `local:${model.name}`,
          label: model.name,
          provider: "openai-compatible",
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
        }),
    );
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
  const localEndpointConnected =
    localDiscovery.connected && providers.length > 0;

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
        capabilities: ["chat", "reasoning", "coding", "documents", "vision", "web", "tools"],
      }),
    );
  }

  providers.push(new DemoProvider());

  return {
    orchestrator: new Orchestrator(providers),
    localEndpointConnected,
    cloudConfigured: Boolean(config.cloud),
  };
}
