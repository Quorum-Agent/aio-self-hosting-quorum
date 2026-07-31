import { leavesDevice, locationTier } from "@quorum/core";
import type {
  Capability,
  ExecutionAttempt,
  LocalRuntimeStatus,
  ModelDescriptor,
  PolicyDefinition,
  RuntimeToolDescriptor,
  TaskPlan,
} from "@quorum/core";

export interface RuntimeStatusView {
  state: "loading" | LocalRuntimeStatus["state"];
  title: string;
  detail: string;
}

export interface RuntimeWarmupView {
  state: "disabled" | "idle" | "warming" | "ready" | "degraded";
  models: Array<{
    model: string;
    role: "classifier" | "general";
    status: "pending" | "warming" | "ready" | "failed";
    detail?: string;
  }>;
}

export interface CloudUsageView {
  activity: boolean;
  selected: boolean;
  contacted: boolean;
  text: string;
}

export interface ModelAttemptView {
  modelId: string;
  label: string;
  stage?: ExecutionAttempt["stage"];
  route: ExecutionAttempt["route"];
  status: ExecutionAttempt["status"] | "selected";
  detail?: string;
  contextMayHaveBeenTransmitted: boolean;
}

export interface ModelAttemptsView {
  attempts: ModelAttemptView[];
  swaps: number;
}

export function describeRuntimeStatus(
  runtime: LocalRuntimeStatus | undefined,
  failed = false,
  warmup?: RuntimeWarmupView,
  webSearch?: RuntimeToolDescriptor,
): RuntimeStatusView {
  const withWebSearch = (detail: string) =>
    webSearch?.available ? `${detail}; web search configured` : detail;
  if (failed) {
    return {
      state: "unavailable",
      title: "Quorum API unavailable",
      detail: "Could not load runtime status",
    };
  }
  if (!runtime) {
    return {
      state: "loading",
      title: "Checking local runtime",
      detail: "Discovering configured models",
    };
  }

  if (!runtime.endpointConnected) {
    return {
      state: "unavailable",
      title: "Local runtime unavailable",
      detail: "Local model endpoint is not connected",
    };
  }

  if (warmup?.state === "warming") {
    const active = warmup.models.find((model) => model.status === "warming");
    return {
      state: "loading",
      title: "Warming local models",
      detail: active
        ? `Loading ${active.model} for ${active.role} work`
        : "Preparing local inference",
    };
  }

  const available = runtime.roles
    .filter((role) => role.available)
    .map((role) => role.role);
  const missing = runtime.roles
    .filter((role) => !role.available)
    .map((role) => role.role);

  if (runtime.state === "ready") {
    return {
      state: "ready",
      title: "Local roles discovered",
      detail:
        `${available.join(", ")}${runtime.promptAnalyzer?.available ? ", classifier" : ""}` +
        `${webSearch?.available ? ", web search" : ""} configured`,
    };
  }

  if (available.length === 0) {
    return {
      state: "degraded",
      title: "Local runtime degraded",
      detail: withWebSearch("Configured models are not installed"),
    };
  }

  const generalMissing = missing.includes("general");
  const analyzerMissing = runtime.promptAnalyzer?.available === false;
  return {
    state: "degraded",
    title: "Local runtime degraded",
    detail: withWebSearch(
      generalMissing
        ? `General model missing; ${available.join(", ")} available`
        : analyzerMissing
          ? `Prompt analyzer ${runtime.promptAnalyzer?.configuredModel} missing`
          : `Missing optional ${missing.join(", ")} expert${missing.length === 1 ? "" : "s"}`,
    ),
  };
}

export function supportsCapability(
  models: ModelDescriptor[],
  capability: Capability,
  policy?: PolicyDefinition,
  route: "any" | "local" = "any",
): boolean {
  return models.some(
    (model) =>
      model.available &&
      model.capabilities.includes(capability) &&
      (route === "any" || model.location === "local") &&
      (!policy ||
        (locationTier(model.location) <= locationTier(policy.inferenceCeiling) &&
          (policy.inferenceCeiling !== "device" ||
            model.transport === "in_process"))),
  );
}

export function selectablePolicies(
  policies: PolicyDefinition[],
): PolicyDefinition[] {
  return policies.filter((policy) => policy.id !== "cost_controlled");
}

export function describeCloudUsage(
  plan: TaskPlan | undefined,
  models: ModelDescriptor[],
): CloudUsageView {
  // "Cloud" in this view has always meant "off this device" rather than one
  // tier's name — the badge it drives says the context left the machine. With
  // tiers between local and cloud, an equality test would have quietly
  // answered "no" for a LAN peer.
  const cloudAttempts =
    plan?.attempts?.filter((attempt) => leavesDevice(attempt.route)) ?? [];
  const selected = plan ? leavesDevice(plan.route) : false;
  const modelContacted = cloudAttempts.some(
    (attempt) => attempt.contextMayHaveBeenTransmitted,
  );
  const webContacted =
    plan?.webSearch?.contextMayHaveLeftDevice === true;
  const contacted = modelContacted || webContacted;
  const labels = [
    ...new Set(
      cloudAttempts.map(
        (attempt) =>
          models.find((model) => model.id === attempt.modelId)?.label ??
          attempt.modelId,
      ),
    ),
  ];
  // This label explains a cloud indicator, so it must name the model that goes
  // to the cloud. Under relay that is the drafting spoke; plan.modelId is the
  // local hub, which would light the badge while naming a local model.
  const selectedLabel =
    models.find(
      (model) => model.id === (plan?.spokeModelId ?? plan?.modelId),
    )?.label ?? "cloud model";
  const webText = webContacted
    ? `Web search via ${plan?.webSearch?.provider}`
    : undefined;
  const routeStage =
    (plan?.attempts?.length ?? 0) > 0 ? "final" : "planned";
  const activityText =
    webText && modelContacted
      ? `${webText}; contacted ${labels.join(", ")}; ${routeStage} model route ${plan?.route}`
      : webText
        ? `${webText}; ${routeStage} model route ${plan?.route}`
        : modelContacted
          ? `Contacted ${labels.join(", ")}; final route ${plan?.route}`
          : undefined;

  return {
    selected,
    contacted,
    activity: selected || contacted,
    text: activityText
      ? activityText
      : selected
        ? `Selected ${selectedLabel}`
        : plan
          ? "None"
          : "No request yet",
  };
}

export function describeModelAttempts(
  plan: TaskPlan | undefined,
  models: ModelDescriptor[],
): ModelAttemptsView {
  if (!plan) return { attempts: [], swaps: 0 };

  const attempts: ModelAttemptView[] = (plan.attempts ?? []).map(
    (attempt) => ({
      modelId: attempt.modelId,
      label:
        models.find((model) => model.id === attempt.modelId)?.label ??
        attempt.modelId,
      ...(attempt.stage ? { stage: attempt.stage } : {}),
      route: attempt.route,
      status: attempt.status,
      ...(attempt.detail ? { detail: attempt.detail } : {}),
      contextMayHaveBeenTransmitted:
        attempt.contextMayHaveBeenTransmitted,
    }),
  );
  const lastAttempt = attempts.at(-1);
  if (!lastAttempt || lastAttempt.modelId !== plan.modelId) {
    const selected = models.find((model) => model.id === plan.modelId);
    // Describe this model, not the plan. Under relay plan.route is "cloud"
    // whenever the spoke is remote, which would label a local hub as cloud and
    // claim its context left the device.
    const route = selected?.location ?? plan.route;
    attempts.push({
      modelId: plan.modelId,
      label: selected?.label ?? plan.modelId,
      route,
      status: "selected",
      contextMayHaveBeenTransmitted: leavesDevice(route),
    });
  }

  // A swap is one model standing in for another that failed. Handing a
  // finished draft to a hub is a pipeline stage, not a swap, so only count a
  // model change that followed a failure.
  const swaps = attempts.reduce((total, attempt, index) => {
    const previous = index > 0 ? attempts[index - 1] : undefined;
    if (!previous || previous.modelId === attempt.modelId) return total;
    return previous.status === "failed" ? total + 1 : total;
  }, 0);

  return {
    attempts,
    swaps,
  };
}
