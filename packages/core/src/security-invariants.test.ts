/**
 * Tests for the security invariants documented in `docs/architecture.md`.
 *
 * REDTEAM-FINDINGS §8 recorded that nobody knew which of those invariants were
 * enforced by a test, and said the answer "should not be read as coverage is
 * fine". This file answers the part of that question that lives in
 * packages/core.
 *
 * Every test here was written against a MUTATION: the invariant was broken in
 * the source, the suite was run, and the test was only kept if it turned red.
 * Where an existing test already caught the mutation, this file does not
 * duplicate it — the mutation result is recorded in a comment instead.
 *
 * The mutations that the pre-existing suite already caught:
 *   - removing the `requiresLocalProcessing` filter (sensitive and
 *     web-grounded requests must stay local): 3 tests failed.
 *   - removing the offline transport filter: 2 tests failed.
 *   - emitting a synthesis step unconditionally, so route plans advertise work
 *     that never happens: 20 tests failed.
 */
import { describe, expect, it } from "vitest";

import { RequestCompiler } from "./request-compiler.js";
import { RoutePlanner } from "./route-planner.js";
import type { ChatRequest, ModelDescriptor, PolicyMode } from "./types.js";

const localModel: ModelDescriptor = {
  id: "local:general",
  label: "Local general",
  provider: "test",
  role: "general",
  location: "local",
  transport: "loopback",
  capabilities: ["chat", "reasoning", "coding", "documents"],
  contextWindow: 32_000,
  qualityRating: 60,
  available: true,
};

// Deliberately rated above ANY score the local model can reach. The
// pre-existing private-mode test used a cloud model rated 90, which loses to
// local on sorting alone because preferLocal adds 100 — so that test passed
// whether or not the policy filter existed. Removing the filter routed private
// requests to cloud with the entire suite still green.
//
// 195 was the first attempt and it was not enough: local's worst case is
// 100 + 60 + 18 + 20 = 198 once a matched specialty and a freshness bonus are
// in play. That fixture passed only because this file's request happens to ask
// for no specialties and no freshness — accidentally sufficient, which is the
// same defect it was written to repair.
//
// 300 clears this fixture's ceiling: 100 (local) + 60 (`localModel`'s rating)
// + 108 (all six non-chat entries in the `Capability` union matched as
// SPECIALTIES at 18 each — `matchedSpecialties` reads `model.specialties`, not
// `model.capabilities`) + 20 (freshness) = 288. The margin no longer depends
// on what this file's request asks for.
const overwhelmingCloudModel: ModelDescriptor = {
  id: "cloud:strong",
  label: "Cloud strong",
  provider: "test",
  location: "cloud",
  transport: "remote",
  capabilities: ["chat", "reasoning", "coding", "documents"],
  contextWindow: 200_000,
  qualityRating: 300,
  available: true,
};

const scaffold: ModelDescriptor = {
  id: "local:scaffold",
  label: "Scaffold",
  provider: "quorum",
  location: "local",
  transport: "in_process",
  capabilities: ["chat"],
  contextWindow: 8_192,
  qualityRating: 5,
  available: true,
};

function request(policy: PolicyMode, content: string): ChatRequest {
  return {
    conversationId: "conversation-1",
    policy,
    messages: [
      {
        id: "message-1",
        role: "user",
        content,
        createdAt: new Date(0).toISOString(),
      },
    ],
  };
}

function planFor(policy: PolicyMode, models: ModelDescriptor[]) {
  return new RoutePlanner().plan(
    new RequestCompiler().compile(request(policy, "Explain this idea to me.")),
    models,
  );
}

// The fixture above only tests anything while the cloud model would actually
// WIN the sort if the policy filter were removed. That is arithmetic, not an
// assumption, and it is the exact thing the original test got wrong — so it is
// asserted rather than trusted.
//
// `localScore` is `(location === "local" ? 100 : 0) + qualityRating +
// 18 per matched specialty + 20 if the request needs freshness and the model
// does web`. This pins the cloud model above every score local can reach, for
// any request, rather than above the score it reaches for this file's request.
//
// Writing it against the current request is what made the first attempt at
// this fixture wrong. If this ever goes red, do not relax it — raise the cloud
// rating, because every test below stops meaning anything the moment a local
// model can win on arithmetic.
describe("the fixture can actually detect the bug it was written for", () => {
  const LOCAL_BONUS = 100;
  const SPECIALTY_BONUS = 18;
  const FRESHNESS_BONUS = 20;
  // Every capability except "chat", which specialtyScore excludes.
  const MAX_SPECIALTIES = 6;

  it("outranks local on score alone, whatever the request asks for", () => {
    const localCeiling =
      LOCAL_BONUS +
      localModel.qualityRating +
      SPECIALTY_BONUS * MAX_SPECIALTIES +
      FRESHNESS_BONUS;

    expect(overwhelmingCloudModel.qualityRating).toBeGreaterThan(localCeiling);
  });
});

describe("a policy that forbids cloud models is not merely a preference", () => {
  // docs/architecture.md: "A policy may be tightened automatically, never
  // weakened silently." A cloud model good enough to outrank local must still
  // be refused rather than merely outranked.
  it.each<PolicyMode>(["private", "offline"])(
    "%s refuses a cloud model that would otherwise win on score",
    (policy) => {
      const plan = planFor(policy, [localModel, overwhelmingCloudModel, scaffold]);

      expect(plan.route).toBe("local");
      expect(plan.modelId).not.toBe(overwhelmingCloudModel.id);
      expect(plan.cloudDisclosure).toBeUndefined();
    },
  );

  it("refuses cloud in private mode even when it is the only capable model", () => {
    // Degrading to the scaffold is the correct outcome. Reaching for the cloud
    // because nothing else can serve the request would be weakening the policy
    // silently, which is the invariant this guards.
    const plan = planFor("private", [overwhelmingCloudModel, scaffold]);

    expect(plan.route).toBe("local");
    expect(plan.modelId).toBe(scaffold.id);
    expect(plan.degraded).toBe(true);
  });

  it("still allows cloud where the policy permits it", () => {
    // The negative tests above would also pass if cloud were broken entirely,
    // so pin the positive direction too.
    const plan = planFor("quality", [localModel, overwhelmingCloudModel]);

    expect(plan.route).toBe("cloud");
    expect(plan.modelId).toBe(overwhelmingCloudModel.id);
    expect(plan.cloudDisclosure).toBeDefined();
  });
});

describe("offline refuses every endpoint that is not in-process", () => {
  // docs/architecture.md: "Offline mode excludes loopback endpoints as well as
  // remote endpoints." Loopback is the easy one to forget, because it is local.
  it("refuses a loopback model even when it is the best available", () => {
    const plan = planFor("offline", [localModel, scaffold]);

    expect(plan.modelId).toBe(scaffold.id);
    expect(plan.steps.every((step) => step.location !== "cloud")).toBe(true);
  });

  it("has no route at all when nothing runs in-process", () => {
    expect(() => planFor("offline", [localModel, overwhelmingCloudModel])).toThrow(
      /No available model satisfies/u,
    );
  });
});
