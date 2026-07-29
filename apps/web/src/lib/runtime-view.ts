import type {
  Capability,
  ExecutionAttempt,
  LocalRuntimeStatus,
  ModelDescriptor,
  PolicyDefinition,
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
): RuntimeStatusView {
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
      detail: `${available.join(", ")}${runtime.promptAnalyzer?.available ? ", classifier" : ""} configured`,
    };
  }

  if (available.length === 0) {
    return {
      state: "degraded",
      title: "Local runtime degraded",
      detail: "Configured models are not installed",
    };
  }

  const generalMissing = missing.includes("general");
  const analyzerMissing = runtime.promptAnalyzer?.available === false;
  return {
    state: "degraded",
    title: "Local runtime degraded",
    detail: generalMissing
      ? `General model missing; ${available.join(", ")} available`
      : analyzerMissing
        ? `Prompt analyzer ${runtime.promptAnalyzer?.configuredModel} missing`
      : `Missing optional ${missing.join(", ")} expert${missing.length === 1 ? "" : "s"}`,
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
        (model.location !== "cloud" || policy.allowCloudModels) &&
          (policy.id !== "offline" || model.transport === "in_process")),
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
  const cloudAttempts =
    plan?.attempts?.filter((attempt) => attempt.route === "cloud") ?? [];
  const selected = plan?.route === "cloud";
  const contacted = cloudAttempts.some(
    (attempt) => attempt.contextMayHaveBeenTransmitted,
  );
  const labels = [
    ...new Set(
      cloudAttempts.map(
        (attempt) =>
          models.find((model) => model.id === attempt.modelId)?.label ??
          attempt.modelId,
      ),
    ),
  ];
  const selectedLabel =
    models.find((model) => model.id === plan?.modelId)?.label ?? "cloud model";

  return {
    selected,
    contacted,
    activity: selected || contacted,
    text: contacted
      ? `Contacted ${labels.join(", ")}; final route ${plan?.route}`
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
    attempts.push({
      modelId: plan.modelId,
      label: selected?.label ?? plan.modelId,
      route: plan.route,
      status: "selected",
      contextMayHaveBeenTransmitted: plan.route === "cloud",
    });
  }

  const swaps = attempts.reduce(
    (total, attempt, index) =>
      index > 0 && attempts[index - 1]?.modelId !== attempt.modelId
        ? total + 1
        : total,
    0,
  );

  return {
    attempts,
    swaps,
  };
}
