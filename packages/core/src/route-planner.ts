import { randomUUID } from "node:crypto";

import { getPolicy } from "./policies.js";
import type {
  CompiledRequest,
  ModelDescriptor,
  PlanStep,
  TaskPlan,
} from "./types.js";

function supports(model: ModelDescriptor, request: CompiledRequest): boolean {
  return request.requirements.capabilities.every((capability) =>
    model.capabilities.includes(capability),
  );
}

function localScore(model: ModelDescriptor, request: CompiledRequest): number {
  let score = model.location === "local" ? 100 : 0;
  score += model.qualityRating;
  if (request.requirements.requiresFreshness && model.capabilities.includes("web")) score += 20;
  return score;
}

function qualityScore(model: ModelDescriptor): number {
  return model.qualityRating * 10 + model.contextWindow / 10_000;
}

export class RoutePlanner {
  plan(request: CompiledRequest, models: ModelDescriptor[]): TaskPlan {
    const policy = getPolicy(request.policy);
    const eligible = models.filter((model) => {
      if (!model.available || !supports(model, request)) return false;
      if (model.location === "cloud" && !policy.allowCloudModels) return false;
      if (request.policy === "offline" && model.transport !== "in_process") return false;
      return true;
    });

    const safeEligible = request.requirements.containsSensitiveData
      ? eligible.filter((model) => model.location === "local")
      : eligible;

    const candidates = request.requirements.containsSensitiveData ? safeEligible : eligible;
    if (candidates.length === 0) {
      throw new Error(
        `No available model satisfies the ${request.policy} policy and required capabilities.`,
      );
    }

    const sorted = [...candidates].sort((left, right) => {
      const leftScore = policy.preferLocal
        ? localScore(left, request)
        : qualityScore(left);
      const rightScore = policy.preferLocal
        ? localScore(right, request)
        : qualityScore(right);
      return rightScore - leftScore;
    });
    const selected = sorted[0];

    if (!selected) {
      throw new Error("The route planner could not select a model.");
    }

    const route = selected.location;
    const rationale =
      route === "local"
        ? `${policy.label} mode selected an available local model with the required capabilities.`
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
        label: `Generate with ${selected.label}`,
        kind: "model",
        location: selected.location,
        modelId: selected.id,
      },
      {
        id: randomUUID(),
        label: "Synthesize response",
        kind: "synthesis",
        location: "device",
      },
    ];

    return {
      id: randomUUID(),
      requestId: request.id,
      route,
      modelId: selected.id,
      rationale,
      steps,
      ...(route === "cloud"
        ? {
            cloudDisclosure:
              "The conversation context required by the selected model will leave this device.",
          }
        : {}),
    };
  }
}
