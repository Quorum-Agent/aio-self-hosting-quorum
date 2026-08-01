import { leavesDevice, locationTier, modelReach } from "@quorum/core";
import type {
  ExecutionLocation,
  Capability,
  CapabilityAdjustment,
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
  /**
   * The plan's actual tier, title-cased for display — "Network", "Remote",
   * "Cloud". The route diagram used to hard-code "Cloud" for anything that
   * left the device, so a model on the operator's own second machine rendered
   * identically to a vendor API. That collapses the distinction the tier model
   * exists to draw: `remote` and `cloud` differ in who controls the stack.
   */
  routeLabel: string;
  /** Heading for the activity block; names the tier rather than "off-device". */
  headingLabel: string;
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

/**
 * Models whose capabilities nothing could confirm.
 *
 * Only available roles are named. A model that is not installed has a
 * capability list nobody is relying on, so reporting it as unverified would be
 * noise about a route that cannot be taken anyway.
 */
export function unverifiedCapabilityModels(
  runtime: LocalRuntimeStatus | undefined,
): string[] {
  return (runtime?.roles ?? [])
    .filter(
      (role) => role.available && role.capabilityProvenance.confirmed.length === 0,
    )
    .map((role) => role.configuredModel);
}

/**
 * The clause appended to an otherwise healthy status line when the runtime
 * overruled the configuration.
 *
 * Counts models rather than listing capabilities, because this sits in a column
 * that compacts to a few words on a narrow window and a list of names would be
 * the first thing truncated. It says enough to send someone to the inspector,
 * which is where the per-model detail lives.
 *
 * Empty string when nothing was adjusted — the common case, and one that must
 * add no noise at all.
 */
/**
 * Per-model provenance for the inspector: which capabilities the runtime
 * examined, and which the planner is trusting on config's word alone.
 *
 * Only available roles, and only when something is asserted — a model whose
 * every capability was confirmed needs no line.
 */
export function describeCapabilityProvenance(
  runtime: LocalRuntimeStatus | undefined,
): Array<{ model: string; confirmed: Capability[]; asserted: Capability[] }> {
  return (runtime?.roles ?? [])
    .filter((role) => role.available && role.capabilityProvenance.asserted.length > 0)
    .map((role) => ({
      model: role.configuredModel,
      confirmed: role.capabilityProvenance.confirmed,
      asserted: role.capabilityProvenance.asserted,
    }));
}

export function describeCapabilityAdjustmentClause(
  runtime: LocalRuntimeStatus | undefined,
): string {
  const adjusted = runtime?.capabilityAdjustments?.length ?? 0;
  const unconfirmed = unverifiedCapabilityModels(runtime).length;
  const clauses: string[] = [];
  if (adjusted > 0) {
    clauses.push(`runtime re-rated ${adjusted} model${adjusted === 1 ? "" : "s"}`);
  }
  // Reported with the same weight as an adjustment, and an external reviewer
  // was right that the first version did not. Adjustments got the status line,
  // the inspector and a log; an unconfirmed capability got the inspector alone
  // — even though it is the riskier of the two. An adjustment is a change the
  // runtime made and stands behind; an unconfirmed capability is a claim the
  // planner acts on that nothing has checked, and it fails at generation
  // rather than at planning.
  if (unconfirmed > 0) {
    clauses.push(
      `capabilities unconfirmed for ${unconfirmed} model${unconfirmed === 1 ? "" : "s"}`,
    );
  }
  return clauses.length > 0 ? ` · ${clauses.join(", ")}` : "";
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
      // "Local model endpoint is not connected" describes the symptom the
      // client can see for itself. When the server knows *why* — a managed
      // runtime that refused to start, and the artifact it choked on — that is
      // the sentence worth the space.
      detail: runtime.problem?.summary ?? "Local model endpoint is not connected",
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

  // A reported cause outranks a description of the symptom on every branch that
  // is not healthy — not just the disconnected one.
  //
  // The first version of this consulted `problem` only where the endpoint was
  // unreachable, which misses the failure that actually happens: the managed
  // runtime refuses an artifact, the configuration falls back to the loopback
  // endpoint, Ollama is running there, and the endpoint therefore *is*
  // connected. The roles are missing, and the header said "Configured models
  // are not installed" — naming the fallback's model names, which is true and
  // is not the reason. Caught by an external reviewer, who pointed out that
  // adding the field and teaching half the view to read it reproduces the
  // defect this branch exists to fix.
  if (runtime.state !== "ready" && runtime.problem) {
    return {
      state: runtime.state,
      title:
        runtime.state === "unavailable"
          ? "Local runtime unavailable"
          : "Local runtime degraded",
      detail: runtime.problem.summary,
    };
  }

  if (runtime.state === "ready") {
    return {
      state: "ready",
      title: "Local roles discovered",
      detail:
        `${available.join(", ")}${runtime.promptAnalyzer?.available ? ", classifier" : ""}` +
        `${webSearch?.available ? ", web search" : ""} configured` +
        // A healthy runtime whose routing differs from the configuration file
        // is still something the operator should be told without going looking
        // for it. Short, because this line has to survive a narrow column; the
        // inspector carries which capabilities moved and in which direction.
        describeCapabilityAdjustmentClause(runtime),
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
      // modelReach, not location. `ModelDescriptor.location` excludes
      // "device", so its minimum tier is 1, while offline's ceiling is
      // "device" = tier 0 — `1 <= 0` was false for EVERY model, and offline
      // showed no starter prompts at all. The transport clause that was meant
      // to handle this ran after a comparison nothing could pass. Matches the
      // planner, which has always used modelReach here.
      (!policy ||
        locationTier(modelReach(model)) <=
          locationTier(policy.inferenceCeiling)),
  );
}

export function selectablePolicies(
  policies: PolicyDefinition[],
): PolicyDefinition[] {
  return policies.filter((policy) => policy.id !== "cost_controlled");
}

/**
 * Display names per tier. `network` is "Local network" rather than "Network"
 * because the tier means a machine on the operator's own LAN, and `remote` is
 * "Remote host" because "Remote" alone reads like a synonym for cloud — which
 * is the exact distinction the tier model exists to preserve.
 */
const TIER_LABELS: Record<Exclude<ExecutionLocation, "device">, string> = {
  local: "Local",
  // `network` and `remote` deliberately share a label. They are distinct tiers
  // — a LAN peer is not a rented box, and the planner treats them differently —
  // but the distinction a *user* is reading this heading for is whether their
  // conversation went to a machine whose stack they control or to a vendor's
  // API. A home server and a RunPod instance are the same answer to that
  // question, and neither is the cloud. `cloud` stays separate because it is
  // the one case where someone else's retention terms apply.
  network: "Remote host",
  remote: "Remote host",
  web: "Web search",
  cloud: "Cloud",
};

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
  const routeLabel = plan ? TIER_LABELS[plan.route] : "Off-device";
  const modelContacted = cloudAttempts.some(
    (attempt) => attempt.contextMayHaveBeenTransmitted,
  );
  const webContacted =
    plan?.webSearch?.contextMayHaveLeftDevice === true;
  const contacted = modelContacted || webContacted;
  // An operator who deliberately configured a LAN peer already knows it is off
  // the device; saying so is noise. Name the tier they set up instead. A single
  // friendly label will not do, though — this heading covers the network,
  // remote AND cloud tiers, so a fixed "Local network" would be actively wrong
  // the moment a vendor API answered.
  const headingLabel = selected
    ? `${routeLabel} activity`
    : webContacted
      ? "Web search"
      : "Off-device activity";
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
    )?.label ?? "an off-device model";
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
    routeLabel,
    headingLabel,
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
