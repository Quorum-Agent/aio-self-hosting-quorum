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

export async function createRuntime(config: AppConfig): Promise<QuorumRuntime> {
  const providers: ModelProvider[] = [];
  const localDiscovery = await discoverModels(
    config.local.baseUrl,
    config.local.apiKey,
  );
  const localEndpointConnected =
    localDiscovery.connected && localDiscovery.modelIds.includes(config.local.model);

  if (localEndpointConnected) {
    providers.push(
      new OpenAICompatibleProvider({
        id: `local:${config.local.model}`,
        label: config.local.model,
        provider: "openai-compatible",
        location: "local",
        baseUrl: config.local.baseUrl,
        apiKey: config.local.apiKey,
        model: config.local.model,
        contextWindow: 32_000,
        qualityRating: 60,
        capabilities: ["chat", "reasoning", "coding", "documents"],
      }),
    );
  }

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
