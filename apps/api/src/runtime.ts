import {
  DemoProvider,
  Orchestrator,
  RoutePlanner,
  type LocalRuntimeProblem,
  type LocalRuntimeStatus,
  type ModelProvider,
  type RuntimeToolDescriptor,
} from "@quorum/core";

import type { AppConfig } from "./config.js";
import { InferenceScheduler } from "./inference-scheduler.js";
import { warmLocalModel } from "./model-warmup.js";
import {
  discoverModels,
  OpenAICompatibleProvider,
} from "./openai-compatible-provider.js";
import { LocalPromptAnalyzer } from "./prompt-analyzer.js";
import {
  ConfigurableWebSearchProvider,
} from "./web-search-provider.js";

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
  readonly webSearch?: RuntimeToolDescriptor;
  webSearchProvider?: ConfigurableWebSearchProvider;
  warmup: Promise<ModelWarmupStatus>;
  warmupStatus: ModelWarmupStatus;
  refreshLocalModels(force?: boolean): Promise<void>;
}

/**
 * Whether a configured model name is present in the runtime's catalogue.
 *
 * Compared case-insensitively, because the two gates a managed model must pass
 * disagreed otherwise. `waitUntilReady` lowercases both sides before comparing
 * catalogue IDs, and `withManagedLlamaEndpoint` checks the configured name
 * against the *manifest*; this checks it against the *catalogue*. An uppercase
 * manifest ID therefore passed startup and passed the manifest check, then
 * failed here once discovery returned the catalogue's spelling — leaving the
 * runtime `degraded` with the UI reporting "Configured models are not
 * installed" and nothing naming case as the cause.
 *
 * The `:latest` fallback stays: Ollama reports an explicit `latest` tag for a
 * name configured without one (Q-09). It is inert against llama.cpp preset
 * IDs, which is harmless.
 */
function modelIsInstalled(
  configuredName: string,
  installedModelIds: readonly string[],
): boolean {
  const configured = configuredName.toLowerCase();
  const installed = installedModelIds.map((id) => id.toLowerCase());
  return (
    installed.includes(configured) ||
    (!configured.includes(":") && installed.includes(`${configured}:latest`))
  );
}

async function discoverLocalModelsWithRetry(
  baseUrl: string,
  apiKey: string,
): ReturnType<typeof discoverModels> {
  const retryDelays = [0, 100, 250, 500];
  let latest = { connected: false, modelIds: [] as string[] };
  for (const delayMs of retryDelays) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    latest = await discoverModels(baseUrl, apiKey);
    if (latest.connected) return latest;
  }
  return latest;
}

export function createLocalProviders(
  config: AppConfig,
  installedModelIds: string[],
  scheduler = new InferenceScheduler(),
): ModelProvider[] {
  return config.local.models
    .filter((model) => modelIsInstalled(model.name, installedModelIds))
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
          nativeOllama: config.local.transport === "ollama",
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
  problem?: LocalRuntimeProblem,
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
    ...(problem ? { problem } : {}),
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
    // Carried forward rather than recomputed. This runs on every status read
    // and every chat dispatch; dropping it here would make the cause visible
    // only on the first poll after startup and then silently disappear, which
    // is worse than never showing it — the operator would see it once and be
    // unable to find it again.
    ...(discovered.problem ? { problem: discovered.problem } : {}),
    state: !discovered.endpointConnected
      ? "unavailable"
      : roles.every((role) => role.available) &&
          discovered.promptAnalyzer?.available !== false
        ? "ready"
        : "degraded",
  };
}

export async function createRuntime(
  config: AppConfig,
  options: { problem?: LocalRuntimeProblem } = {},
): Promise<QuorumRuntime> {
  const scheduler = new InferenceScheduler();
  const localDiscovery = await discoverLocalModelsWithRetry(
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
    modelIsInstalled(
      config.local.promptAnalyzer.name,
      localDiscovery.modelIds,
    );
  let localRuntime = describeLocalRuntime(
    config,
    localDiscovery.connected,
    providers,
    promptAnalyzerAvailable,
    options.problem,
  );
  const promptAnalyzer = promptAnalyzerAvailable
    ? new LocalPromptAnalyzer({
        id: `local:classifier:${config.local.promptAnalyzer.name}`,
        label: config.local.promptAnalyzer.name,
        baseUrl: config.local.baseUrl,
        apiKey: config.local.apiKey,
        model: config.local.promptAnalyzer.name,
        contextWindow: config.local.promptAnalyzer.contextWindow,
        nativeOllama: config.local.transport === "ollama",
        scheduler,
      })
    : undefined;

  if (config.network) {
    providers.push(
      new OpenAICompatibleProvider({
        id: `network:${config.network.model}`,
        label: config.network.model,
        provider: "openai-compatible",
        location: "network",
        baseUrl: config.network.baseUrl,
        apiKey: config.network.apiKey,
        model: config.network.model,
        contextWindow: config.network.contextWindow,
        qualityRating: config.network.qualityRating,
        capabilities: ["chat", "reasoning", "coding", "documents"],
        // A peer speaks the OpenAI-compatible protocol, never Ollama's native
        // one — this is another Quorum or a llama-server, addressed remotely.
        nativeOllama: false,
        // Deliberately no scheduler. The local InferenceScheduler serialises
        // access to THIS machine's GPU; a peer has its own. Passing it would
        // make a remote model queue behind local inference for no reason. The
        // cloud provider omits it for the same reason.
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
        contextWindow: config.cloud.contextWindow,
        qualityRating: config.cloud.qualityRating,
        capabilities: ["chat", "reasoning", "coding", "documents"],
        // A cloud vendor is never Ollama. This was previously implicit — the
        // option defaulted falsy here and to native at two other call sites,
        // which is the inconsistency that made the option required.
        nativeOllama: false,
      }),
    );
  }

  const webSearch = new ConfigurableWebSearchProvider(config.webSearch);

  providers.push(new DemoProvider());
  const orchestrator = new Orchestrator(
    providers,
    undefined,
    new RoutePlanner(config.orchestrationMode ?? "route"),
    promptAnalyzer,
    webSearch,
  );
  let refreshInFlight: Promise<void> | undefined;
  let lastRefreshAt = 0;
  const refreshLocalModels = async (force = false): Promise<void> => {
    if (
      localRuntime.endpointConnected &&
      localRuntime.roles.every((role) => role.available) &&
      localRuntime.promptAnalyzer?.available !== false
    ) {
      return;
    }
    if (refreshInFlight) return refreshInFlight;
    if (!force && Date.now() - lastRefreshAt < 5_000) return;
    lastRefreshAt = Date.now();
    refreshInFlight = (async () => {
      const refreshed = await discoverModels(
        config.local.baseUrl,
        config.local.apiKey,
      );
      if (!refreshed.connected) {
        localRuntime = describeLocalRuntime(config, false, [], false);
        return;
      }
      const refreshedProviders = createLocalProviders(
        config,
        refreshed.modelIds,
        scheduler,
      );
      const registeredProviderIds = new Set(
        orchestrator.models.map((model) => model.id),
      );
      for (const provider of refreshedProviders) {
        if (!registeredProviderIds.has(provider.model.id)) {
          orchestrator.registerProvider(provider);
        }
      }
      const analyzerAvailable = modelIsInstalled(
        config.local.promptAnalyzer.name,
        refreshed.modelIds,
      );
      const analyzerWasAvailable =
        localRuntime.promptAnalyzer?.available === true;
      if (analyzerAvailable && !analyzerWasAvailable) {
        orchestrator.setPromptAnalyzer(
          new LocalPromptAnalyzer({
            id: `local:classifier:${config.local.promptAnalyzer.name}`,
            label: config.local.promptAnalyzer.name,
            baseUrl: config.local.baseUrl,
            apiKey: config.local.apiKey,
            model: config.local.promptAnalyzer.name,
            contextWindow: config.local.promptAnalyzer.contextWindow,
            nativeOllama: config.local.transport === "ollama",
            scheduler,
          }),
        );
      } else if (!analyzerAvailable && analyzerWasAvailable) {
        orchestrator.setPromptAnalyzer(undefined);
      }
      localRuntime = describeLocalRuntime(
        config,
        true,
        refreshedProviders,
        analyzerAvailable,
      );
    })().finally(() => {
      refreshInFlight = undefined;
    });
    return refreshInFlight;
  };
  const generalModel = config.local.models.find(
    (model) =>
      model.role === "general" &&
      modelIsInstalled(model.name, localDiscovery.modelIds),
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
          nativeOllama: config.local.transport === "ollama",
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
    get webSearch() {
      return webSearch.tool;
    },
    webSearchProvider: webSearch,
    warmup,
    get warmupStatus() {
      return warmupStatus;
    },
    refreshLocalModels,
  };
}
