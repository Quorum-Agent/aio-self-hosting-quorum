import { randomUUID } from "./uuid.js";

import { getPolicy } from "./policies.js";
import { leavesDevice, locationTier, modelReach } from "./types.js";
import type {
  Capability,
  CompiledRequest,
  ExecutionLocation,
  ModelDescriptor,
  OrchestrationMode,
  PlanStep,
  TaskPlan,
} from "./types.js";

/**
 * How far this plan actually reaches: the furthest tier of any step.
 *
 * Previously `route` was the *spoke's* location, so a stage running further
 * out than the spoke would have been invisible to every consumer that keyed
 * off it, including the disclosure.
 *
 * Two honest caveats. Retrieval is **not** covered — it is excluded by the
 * kind filter below and disclosed separately, because a search provider
 * receives the query while a model receives the conversation. And the maximum
 * is currently unreachable: `#selectHub` requires a hub with
 * `location === "local"`, the lowest tier any `ModelDescriptor` can have, so
 * `max(spoke, hub)` always equals the spoke. Reverting this to
 * `selected.location` passes every test. It is kept as the correct shape for
 * when a hub may sit further out, not because it changes an outcome today.
 */
function planReach(steps: readonly PlanStep[]): Exclude<ExecutionLocation, "device"> {
  let reach: Exclude<ExecutionLocation, "device"> = "local";
  for (const step of steps) {
    // Only stages that receive conversation content. Retrieval is excluded on
    // purpose: it egresses too, but it egresses a *query*, and it carries its
    // own disclosure via `webSearch.contextMayHaveLeftDevice`. Including it
    // would report a local model as a cloud route whenever a search ran, which
    // is a different lie rather than a fix. Filtering by kind also means a step
    // spliced in later — retrieval is added by the orchestrator after this
    // runs — cannot silently change the route.
    if (step.kind !== "model" && step.kind !== "synthesis") continue;
    if (step.location === "device") continue;
    if (locationTier(step.location) > locationTier(reach)) reach = step.location;
  }
  return reach;
}

const SPECIALTY_BONUS = 18;

// Matches the orchestrator's failure bookkeeping: two configured roles may
// point at the same underlying model, and relaying a model to itself is pure
// cost, so identity is compared physically rather than by configured id.
function physicalIdentity(model: ModelDescriptor): string {
  return `${model.location}:${model.provider}:${model.label}`;
}

function supports(model: ModelDescriptor, request: CompiledRequest): boolean {
  return request.requirements.capabilities.every((capability) =>
    model.capabilities.includes(capability),
  );
}

function matchedSpecialties(
  model: ModelDescriptor,
  request: CompiledRequest,
): Capability[] {
  return [...new Set(model.specialties ?? [])].filter(
    (capability) =>
      capability !== "chat" &&
      request.requirements.capabilities.includes(capability),
  );
}

function specialtyScore(model: ModelDescriptor, request: CompiledRequest): number {
  return matchedSpecialties(model, request).length * SPECIALTY_BONUS;
}

function localScore(model: ModelDescriptor, request: CompiledRequest): number {
  let score = model.location === "local" ? 100 : 0;
  score += model.qualityRating;
  score += specialtyScore(model, request);
  if (request.requirements.requiresFreshness && model.capabilities.includes("web")) score += 20;
  return score;
}

export class RoutePlanner {
  readonly #mode: OrchestrationMode;

  constructor(mode: OrchestrationMode = "route") {
    this.#mode = mode;
  }

  // The hub is the general-purpose model: the one role expected to hold a
  // consistent voice across whatever specialist drafted the answer.
  //
  // It is chosen from the SAME candidate set the spoke came from, never from
  // the raw model list. Those candidates already encode policy, capability,
  // availability and exclusions, so the hub cannot reach somewhere the spoke
  // was forbidden to go — selecting from raw models let offline mode, which
  // permits only in-process transports, pick a loopback hub.
  //
  // Returns undefined whenever relaying would be pointless or impossible, in
  // which case the plan degrades to a single model.
  #selectHub(
    candidates: ModelDescriptor[],
    spoke: ModelDescriptor,
  ): ModelDescriptor | undefined {
    if (this.#mode !== "relay") return undefined;
    const spokeIdentity = physicalIdentity(spoke);
    return candidates.find(
      (model) =>
        model.role === "general" &&
        model.location === "local" &&
        physicalIdentity(model) !== spokeIdentity,
    );
  }

  plan(
    request: CompiledRequest,
    models: ModelDescriptor[],
    excludedModelIds: ReadonlySet<string> = new Set(),
  ): TaskPlan {
    const policy = getPolicy(request.policy);
    const eligible = models.filter((model) => {
      if (excludedModelIds.has(model.id)) return false;
      if (!model.available || !supports(model, request)) return false;
      // One comparison replaces two rules. The old pair was a cloud-only flag
      // plus a policy special-cased BY NAME — `request.policy === "offline"` —
      // which meant invariant I-4 ("offline excludes loopback as well as
      // remote") lived in the planner rather than in the policy. `offline`
      // now simply declares a ceiling of `device`, and any tier added later is
      // covered without touching this line.
      if (locationTier(modelReach(model)) > locationTier(policy.inferenceCeiling)) {
        return false;
      }
      return true;
    });

    const requiresLocalProcessing =
      request.requirements.containsSensitiveData ||
      request.requirements.containsWebGroundedData;
    // Deliberately an equality test, not a ceiling comparison. This is a
    // floor on data sensitivity, independent of what the policy permits:
    // sensitive or web-grounded content must stay on the device even under a
    // policy whose ceiling would allow a LAN peer.
    const safeEligible = requiresLocalProcessing
      ? eligible.filter((model) => model.location === "local")
      : eligible;

    let candidates = requiresLocalProcessing ? safeEligible : eligible;
    let degraded = false;
    if (candidates.length === 0) {
      candidates = models.filter(
        (model) =>
          !excludedModelIds.has(model.id) &&
          model.available &&
          model.location === "local" &&
          model.transport === "in_process" &&
          model.provider === "quorum" &&
          model.capabilities.includes("chat"),
      );
      degraded = candidates.length > 0;
    }
    if (candidates.length === 0) {
      throw new Error(
        // `policy.label`, not `request.policy` — the id leaks "cost_controlled"
        // into a user-facing sentence where every other message here uses the
        // label ("Best quality").
        `No available model satisfies the ${policy.label} policy and required capabilities.`,
      );
    }

    const sorted = [...candidates].sort((left, right) => {
      if (policy.preferLocal) {
        return localScore(right, request) - localScore(left, request);
      }
      const qualityDifference =
        right.qualityRating +
        specialtyScore(right, request) -
        (left.qualityRating + specialtyScore(left, request));
      if (qualityDifference !== 0) return qualityDifference;
      return right.contextWindow - left.contextWindow;
    });
    const selected = sorted[0];

    if (!selected) {
      throw new Error("The route planner could not select a model.");
    }
    degraded ||= selected.id === "local:scaffold";

    // Ranked, not raw: the hub writes the answer the user reads, so among
    // several general models it should be the best one rather than whichever
    // was declared first.
    const hub = this.#selectHub(sorted, selected);
    const selectedSpecialties = matchedSpecialties(selected, request);
    const rationale = degraded
      ? `${policy.label} mode found no model with every required capability; the local scaffold will explain the limitation.`
      : !leavesDevice(selected.location)
        ? selectedSpecialties.length > 0
          ? `${policy.label} mode selected a local ${selectedSpecialties.join(" and ")} specialist.`
          : `${policy.label} mode selected an available local model with the required capabilities.`
        : `${policy.label} mode selected a ${selected.location} model because it best matches the request requirements.`;
    const steps: PlanStep[] = [
      {
        id: randomUUID(),
        label: "Compile request context",
        kind: "compile",
        location: "device",
      },
      {
        id: randomUUID(),
        label: `Apply ${policy.label.toLowerCase()} policy`,
        kind: "policy",
        location: "device",
      },
      {
        id: randomUUID(),
        label: hub ? `Draft with ${selected.label}` : `Generate with ${selected.label}`,
        kind: "model",
        location: selected.location,
        modelId: selected.id,
      },
      // Only present when something actually synthesizes. A step that performs
      // no work would contradict the disclosure invariant in
      // docs/architecture.md, which is why route mode has no synthesis step.
      // It must stay last: the orchestrator re-splices retrieval steps around
      // the leading device steps when it falls back.
      ...(hub
        ? [
            {
              id: randomUUID(),
              label: `Synthesize with ${hub.label}`,
              kind: "synthesis" as const,
              location: hub.location,
              modelId: hub.id,
            },
          ]
        : []),
    ];

    // Computed from the finished step list, so a stage that reaches further
    // than the selected model cannot go unreported.
    const route = planReach(steps);

    return {
      id: randomUUID(),
      requestId: request.id,
      policy: request.policy,
      verbosity: request.verbosity,
      analysis: request.analysis,
      route,
      // The model whose words the user reads: the hub when one synthesizes.
      modelId: hub?.id ?? selected.id,
      ...(hub ? { spokeModelId: selected.id } : {}),
      // Say when relay was configured but did not engage. Otherwise the plan
      // is indistinguishable from route mode and a misconfiguration — a
      // general model outranking every specialist, say — looks like normal
      // operation forever.
      rationale: hub
        ? `${rationale} ${hub.label} will synthesize the final answer.`
        : this.#mode === "relay"
          ? `${rationale} No second general model could serve this request, so one model answered directly.`
          : rationale,
      // Relay configured but not engaged, for the same reason the orchestrator
      // sets this when a planned hub fails: the operator asked for two stages
      // and got one, and that should be detectable rather than only readable.
      ...(this.#mode === "relay" && !hub ? { synthesisDegraded: true } : {}),
      steps,
      ...(degraded ? { degraded: true } : {}),
      safety: {
        sensitiveDataCategories:
          request.requirements.sensitiveDataCategories,
        containsWebGroundedData:
          request.requirements.containsWebGroundedData,
      },
      // Keyed on whether anything left the device, not on one tier's name. A
      // `network` or `remote` step used to produce no disclosure at all,
      // because only `"cloud"` was tested.
      ...(leavesDevice(route)
        ? {
            cloudDisclosure:
              "The conversation context required by the selected model will leave this device.",
          }
        : {}),
    };
  }
}
