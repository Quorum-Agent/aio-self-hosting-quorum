import { randomUUID } from "node:crypto";

import { getPolicy } from "./policies.js";
import type {
  Capability,
  CompiledRequest,
  ModelDescriptor,
  OrchestrationMode,
  PlanStep,
  TaskPlan,
} from "./types.js";

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

  // The hub is the general-purpose local model: it is the one role expected to
  // hold a consistent voice across whatever specialist drafted the answer.
  // Returns undefined whenever relaying would be pointless or impossible, in
  // which case the plan degrades to a single model.
  #selectHub(
    models: ModelDescriptor[],
    spoke: ModelDescriptor,
    excludedModelIds: ReadonlySet<string>,
  ): ModelDescriptor | undefined {
    if (this.#mode !== "relay") return undefined;
    const spokeIdentity = physicalIdentity(spoke);
    return models.find(
      (model) =>
        model.role === "general" &&
        model.available &&
        model.location === "local" &&
        !excludedModelIds.has(model.id) &&
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
      if (model.location === "cloud" && !policy.allowCloudModels) return false;
      if (request.policy === "offline" && model.transport !== "in_process") return false;
      return true;
    });

    const requiresLocalProcessing =
      request.requirements.containsSensitiveData ||
      request.requirements.containsWebGroundedData;
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
        `No available model satisfies the ${request.policy} policy and required capabilities.`,
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

    const hub = this.#selectHub(models, selected, excludedModelIds);
    // Context leaves the device if EITHER stage is remote, so the disclosure
    // below must reflect the whole plan rather than the answering model.
    const route =
      selected.location === "cloud" || hub?.location === "cloud"
        ? "cloud"
        : selected.location;
    const selectedSpecialties = matchedSpecialties(selected, request);
    const rationale = degraded
      ? `${policy.label} mode found no model with every required capability; the local scaffold will explain the limitation.`
      : route === "local"
        ? selectedSpecialties.length > 0
          ? `${policy.label} mode selected a local ${selectedSpecialties.join(" and ")} specialist.`
          : `${policy.label} mode selected an available local model with the required capabilities.`
        : `${policy.label} mode selected a cloud model because it best matches the request requirements.`;
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
      rationale: hub
        ? `${rationale} ${hub.label} will synthesize the final answer.`
        : rationale,
      steps,
      ...(degraded ? { degraded: true } : {}),
      safety: {
        sensitiveDataCategories:
          request.requirements.sensitiveDataCategories,
        containsWebGroundedData:
          request.requirements.containsWebGroundedData,
      },
      ...(route === "cloud"
        ? {
            cloudDisclosure:
              "The conversation context required by the selected model will leave this device.",
          }
        : {}),
    };
  }
}
