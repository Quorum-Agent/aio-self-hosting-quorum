import {
  DemoProvider,
  Orchestrator,
  RoutePlanner,
  type Capability,
  type CapabilityAdjustment,
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
  fetchOllamaCapabilities,
  reconcileCapabilities,
  splitCapabilityProvenance,
} from "./runtime-capabilities.js";
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

/**
 * Ask the runtime what each configured model can do.
 *
 * Only the Ollama transport answers this — `/api/show` is its native route, and
 * an OpenAI-compatible endpoint has no equivalent. A transport that cannot be
 * asked yields no entry, which `reconcileCapabilities` reads as "no
 * information" rather than "no capabilities"; the difference is every request
 * the model would otherwise serve.
 *
 * Probes run concurrently against a loopback endpoint that discovery has
 * already reached, each with its own short timeout, so a single unresponsive
 * model cannot hold up startup.
 */
export async function probeRuntimeCapabilities(
  config: AppConfig,
  installedModelIds: string[],
): Promise<Map<string, Capability[]>> {
  const probed = new Map<string, Capability[]>();
  if (config.local.transport !== "ollama") return probed;

  const names = config.local.models
    .filter((model) => modelIsInstalled(model.name, installedModelIds))
    .map((model) => model.name);

  // Batched rather than fanned out. `Promise.all` over the whole list sends one
  // request per configured model at once, and a large local catalogue would
  // then overload the very endpoint being asked — producing timeouts, which
  // this code reads as "could not ask" and turns into unconfirmed capabilities.
  // A probe that fails under its own load is worse than a slower one.
  const CONCURRENCY = 4;
  for (let index = 0; index < names.length; index += CONCURRENCY) {
    const batch = names.slice(index, index + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (name) => ({
        name,
        capabilities: await fetchOllamaCapabilities(config.local.baseUrl, name),
      })),
    );
    for (const result of results) {
      if (result.capabilities) probed.set(result.name, result.capabilities);
    }
  }
  return probed;
}

export function createLocalProviders(
  config: AppConfig,
  installedModelIds: string[],
  scheduler = new InferenceScheduler(),
  runtimeCapabilities: ReadonlyMap<string, Capability[]> = new Map(),
): ModelProvider[] {
  return config.local.models
    .filter((model) => modelIsInstalled(model.name, installedModelIds))
    .map((model) => {
      const reconciled = reconcileCapabilities(
        model.capabilities,
        runtimeCapabilities.get(model.name),
      );
      return new OpenAICompatibleProvider({
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
        capabilities: reconciled.capabilities,
        specialties: model.specialties,
        nativeOllama: config.local.transport === "ollama",
        ...(model.reasoningEffort
          ? { reasoningEffort: model.reasoningEffort }
          : {}),
        scheduler,
      });
    });
}

/**
 * What the runtime changed, for the operator to read.
 *
 * Derived from the same inputs `createLocalProviders` reconciles, rather than
 * recorded as a side effect of building them — a side channel out of a
 * constructor is how one fact ends up with two representations that can
 * disagree. Models the runtime agreed with produce no entry.
 */
export function describeCapabilityAdjustments(
  config: AppConfig,
  installedModelIds: string[],
  runtimeCapabilities: ReadonlyMap<string, Capability[]>,
): CapabilityAdjustment[] {
  return config.local.models
    .filter((model) => modelIsInstalled(model.name, installedModelIds))
    .flatMap((model) => {
      const { added, removed } = reconcileCapabilities(
        model.capabilities,
        runtimeCapabilities.get(model.name),
      );
      if (added.length === 0 && removed.length === 0) return [];
      return [{ model: model.name, added, removed }];
    });
}

export function describeLocalRuntime(
  config: AppConfig,
  endpointConnected: boolean,
  providers: ModelProvider[],
  promptAnalyzerAvailable: boolean,
  problem?: LocalRuntimeProblem,
  runtimeCapabilities: ReadonlyMap<string, Capability[]> = new Map(),
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
      // Presence in the probe map *is* the provenance. Deriving it from the
      // same value the reconciliation reads means the two cannot disagree
      // about whether this model was asked.
      capabilityProvenance: splitCapabilityProvenance(
        reconcileCapabilities(
          model.capabilities,
          runtimeCapabilities.get(model.name),
        ).capabilities,
        runtimeCapabilities.has(model.name),
      ),
    };
  });
  // Computed here from the same input rather than passed in beside it. An
  // earlier version took the adjustments as a separate argument, which is one
  // fact arriving through two channels — the shape most defects in this
  // repository take.
  //
  // The installed set is the configured *names* of models that got a provider,
  // not `provider.model.label`. Those are equal today and are not the same
  // thing: `modelIsInstalled` matches machine names, so the moment a label is
  // humanised every adjustment would be silently dropped from the status and
  // the log. Caught by review before it could bite.
  const installedNames = config.local.models
    .filter((model) => providerIds.has(`local:${model.role}:${model.name}`))
    .map((model) => model.name);
  const capabilityAdjustments = describeCapabilityAdjustments(
    config,
    installedNames,
    runtimeCapabilities,
  );

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
    ...(capabilityAdjustments.length > 0 ? { capabilityAdjustments } : {}),
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
    // Carried forward for the same reason the cause above is: the status is
    // rebuilt on every poll, and an adjustment that vanished after the first
    // read would leave the operator unable to find the explanation again.
    ...(discovered.capabilityAdjustments
      ? { capabilityAdjustments: discovered.capabilityAdjustments }
      : {}),
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
  options: {
    problem?: LocalRuntimeProblem;
    onCapabilityAdjustment?: (adjustment: CapabilityAdjustment) => void;
    onCapabilitiesUnconfirmed?: (
      model: string,
      asserted: Capability[],
    ) => void;
  } = {},
): Promise<QuorumRuntime> {
  const scheduler = new InferenceScheduler();
  const localDiscovery = await discoverLocalModelsWithRetry(
    config.local.baseUrl,
    config.local.apiKey,
  );
  const installedModelIds = localDiscovery.connected
    ? localDiscovery.modelIds
    : [];
  const runtimeCapabilities = await probeRuntimeCapabilities(
    config,
    installedModelIds,
  );
  const providers = createLocalProviders(
    config,
    installedModelIds,
    scheduler,
    runtimeCapabilities,
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
    runtimeCapabilities,
  );
  // The durable half of the record, read off the status rather than collected
  // alongside it — a routing change the operator did not make is exactly what
  // someone greps for months later, and it must say the same thing the
  // interface said.
  for (const adjustment of localRuntime.capabilityAdjustments ?? []) {
    options.onCapabilityAdjustment?.(adjustment);
  }
  // The unconfirmed case gets the same durable record, because it is the one
  // that fails later and further from its cause. An adjustment is a decision
  // the runtime made; an unconfirmed capability is a claim the planner will act
  // on that nothing checked, and the first sign of it is a request failing at
  // generation.
  for (const role of localRuntime.roles) {
    if (!role.available) continue;
    if (role.capabilityProvenance.confirmed.length > 0) continue;
    options.onCapabilitiesUnconfirmed?.(
      role.configuredModel,
      role.capabilityProvenance.asserted,
    );
  }
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
      // Re-probed, not carried over. The startup probe is one HTTP call per
      // model against a runtime that may still have been starting; freezing its
      // answer meant a boot-time blip left capabilities unconfirmed until the
      // process restarted, with nothing saying the reading was stale.
      const refreshedCapabilities = await probeRuntimeCapabilities(
        config,
        refreshed.modelIds,
      );
      const refreshedProviders = createLocalProviders(
        config,
        refreshed.modelIds,
        scheduler,
        refreshedCapabilities,
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
        undefined,
        refreshedCapabilities,
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
