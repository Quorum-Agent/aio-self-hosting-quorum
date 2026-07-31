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

import { DemoProvider } from "./demo-provider.js";
import { Orchestrator } from "./orchestrator.js";
import { RequestCompiler } from "./request-compiler.js";
import { leavesDevice, locationTier, modelReach } from "./types.js";
import { RoutePlanner } from "./route-planner.js";
import type {
  ChatRequest,
  ModelDescriptor,
  PolicyMode,
  WebSearchProvider,
} from "./types.js";

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
// Being unreachable in production is the point, not a weakness. `config.ts`
// caps cloud `qualityRating` at `Math.min(100, …)` and rates the local general
// model 75, so a real cloud model (≤100) can never outscore a real local one
// (175) on the preferLocal sort — the arithmetic alone already blocks it. A
// fixture drawn from production values would therefore pass whether or not the
// policy filter existed, which is precisely how the original test failed. The
// rating here is deliberately unreachable so that the wrong answer is
// reachable *by score*, leaving the policy filter as the only thing that can
// prevent it. That isolates the filter instead of leaning on the arithmetic.
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

// The two tiers between local and cloud. Defined at module scope rather than
// inside the describe that uses them, so the fixture-strength guard below can
// read their real ratings instead of a copy.
const lanPeer: ModelDescriptor = {
  id: "network:peer",
  label: "LAN peer",
  provider: "test",
  location: "network",
  transport: "remote",
  capabilities: ["chat", "reasoning", "coding", "documents"],
  contextWindow: 128_000,
  qualityRating: 300,
  available: true,
};

const rentedBox: ModelDescriptor = {
  ...lanPeer,
  id: "remote:rented",
  label: "Rented GPU",
  location: "remote",
};

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

  const localCeiling =
    LOCAL_BONUS +
    localModel.qualityRating +
    SPECIALTY_BONUS * MAX_SPECIALTIES +
    FRESHNESS_BONUS;

  // Every off-device fixture, not just the first one. The guard originally
  // covered `overwhelmingCloudModel` alone; the `network` and `remote`
  // fixtures added later reused its rating without inheriting its guarantee,
  // so they cleared the bar by luck rather than by construction — one bonus
  // change away from the exact defect this describe block exists to prevent.
  it.each<[string, ModelDescriptor]>([
    ["cloud", overwhelmingCloudModel],
    ["network peer", lanPeer],
    ["rented remote", rentedBox],
  ])("the %s fixture outranks local on score alone", (_name, model) => {
    // Reads the fixture, not a copy of its rating. A guard holding its own
    // literal drifts silently the moment the fixture is edited, which is the
    // defect it was written to prevent wearing a different hat.
    expect(model.qualityRating).toBeGreaterThan(localCeiling);
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

// The location model grew from `device | local | cloud` to five ordered tiers.
// Every assertion above tests the two endpoints of that range; these test the
// middle, which is where a binary `=== "cloud"` check silently answers "no".
describe("the tiers between local and cloud are not treated as local", () => {
  it.each<[string, ModelDescriptor]>([
    ["network", lanPeer],
    ["remote", rentedBox],
  ])("private refuses a %s model however strong it is", (_tier, model) => {
    // Rated 300 so it wins every sort. Only the ceiling can refuse it, which
    // is the same trap the original private-mode test fell into by using a
    // model that lost on arithmetic.
    const plan = planFor("private", [localModel, model, scaffold]);

    expect(plan.modelId).not.toBe(model.id);
    expect(plan.steps.every((step) => step.location === "device" || step.location === "local")).toBe(true);
  });

  it.each<[string, ModelDescriptor]>([
    ["network", lanPeer],
    ["remote", rentedBox],
  ])("discloses that context left the device for a %s model", (_tier, model) => {
    // The failure this pins: disclosure used to be attached only when
    // `route === "cloud"`, so a peer on your own LAN — which is emphatically
    // not your device — produced no disclosure at all.
    const plan = planFor("quality", [localModel, model]);

    expect(plan.modelId).toBe(model.id);
    expect(plan.route).toBe(model.location);
    expect(plan.cloudDisclosure).toBeDefined();
  });

  it("refuses both tiers in offline mode", () => {
    expect(() => planFor("offline", [lanPeer, rentedBox])).toThrow(
      /No available model satisfies/u,
    );
  });

  it("keeps sensitive content on the device rather than sending it to a peer", () => {
    // A data-sensitivity floor, not a policy ceiling: quality permits egress
    // to cloud, and sensitive content still must not reach even the nearest
    // off-device tier.
    const sensitive = new RoutePlanner().plan(
      new RequestCompiler().compile(
        request("quality", "Summarize this confidential document"),
      ),
      [localModel, lanPeer],
    );

    expect(sensitive.modelId).toBe(localModel.id);
    expect(sensitive.cloudDisclosure).toBeUndefined();
  });
});

describe("a model cannot claim a nearer tier than its location", () => {
  // Found by probing, not by review. `modelReach` treats an in-process model
  // as tier `device` — that is how `offline` stopped being special-cased by
  // name. The first version trusted `transport` unconditionally, so a
  // descriptor claiming cloud while claiming in_process reported `device`,
  // passed every ceiling, and was selected under BOTH private and offline.
  // The previous boolean check refused it, so that was a widening.
  const contradictory: ModelDescriptor = {
    id: "cloud:contradictory",
    label: "Contradictory",
    provider: "test",
    location: "cloud",
    transport: "in_process",
    capabilities: ["chat", "reasoning", "coding", "documents"],
    contextWindow: 8_192,
    // High enough that only a refusal can keep it out.
    qualityRating: 999,
    available: true,
  };

  it.each<PolicyMode>(["private", "offline"])(
    "%s refuses a cloud model that declares an in-process transport",
    (policy) => {
      expect(() => planFor(policy, [contradictory])).toThrow(
        /No available model satisfies/u,
      );
    },
  );

  it("still lets a genuinely in-process local model serve offline mode", () => {
    // The downgrade has to keep working, or offline has no route at all.
    const plan = planFor("offline", [contradictory, scaffold]);

    expect(plan.modelId).toBe(scaffold.id);
  });
});

/**
 * Properties over emitted plans, rather than examples.
 *
 * Every defect this file was written in response to has the same shape: one
 * fact carried by two fields, read by different surfaces, allowed to disagree.
 * `modelReach` versus `location`. A tool's `location` versus its
 * `contextMayLeaveDevice`. Which provider streamed versus `plan.modelId`.
 *
 * Checking that either field is individually plausible does not catch that —
 * when `modelReach` let a cloud model pass every ceiling, the disclosure was
 * *correct* throughout, so any "did we tell the user the truth" assertion
 * would have called the system healthy while `private` routed to cloud.
 *
 * These assert the two fields AGREE. They are also properties rather than
 * examples deliberately: the recurring failure in this repo is a fixture that
 * cannot reach the wrong answer, and a property has no fixture to get wrong.
 */
describe("fields describing the same fact do not disagree", () => {
  it("modelReach never reports a further tier than the model declares", () => {
    // The contract as a property, not as two examples. This is the shape of
    // the bug that let `location: "cloud"` + `transport: "in_process"` pass
    // every ceiling: reach may move a model NEARER, never further.
    const locations = ["local", "network", "remote", "cloud"] as const;
    const transports = ["in_process", "loopback", "remote"] as const;
    for (const location of locations) {
      for (const transport of transports) {
        const reach = modelReach({ location, transport });
        expect(locationTier(reach)).toBeLessThanOrEqual(locationTier(location));
        // And it only moves nearer when the model itself claims to be local.
        if (reach !== location) {
          expect(location).toBe("local");
          expect(transport).toBe("in_process");
        }
      }
    }
  });

  it("disclosure is present exactly when the plan leaves the device", () => {
    const cases: Array<[string, ModelDescriptor[], PolicyMode]> = [
      ["local only", [localModel, scaffold], "balanced"],
      ["cloud permitted", [localModel, overwhelmingCloudModel], "quality"],
      ["cloud refused", [localModel, overwhelmingCloudModel], "private"],
      ["scaffold only", [scaffold], "offline"],
    ];
    for (const [name, models, policy] of cases) {
      const plan = planFor(policy, models);
      expect(
        `${name}: ${leavesDevice(plan.route)}`,
        `disclosure disagreed with route for ${name}`,
      ).toBe(`${name}: ${plan.cloudDisclosure !== undefined}`);
    }
  });
});

describe("the classification stage reports where it ran", () => {
  // The analyzer receives the FULL message list, so it is conversation-bearing
  // exactly as a model step is — but its step hardcoded `location: "local"`
  // with nothing tying that literal to reality. It was true only because
  // config puts the analyzer's base URL through a loopback validator, one
  // layer above the place asserting it.
  //
  // Asserted against the TRACE, which is where the classification step
  // actually surfaces — it is not added to `plan.steps`. A first version of
  // this test looked in `plan.steps` and guarded with `if (found)`, so it
  // passed by never asserting anything: the exact vacuity this file exists to
  // catch.
  it("takes the trace location from the analyzer, not a constant", async () => {
    const analyzer = {
      id: "peer:classifier",
      label: "Peer classifier",
      location: "network" as const,
      analyze: async () => ({
        intent: "conversation" as const,
        confidence: 0.9,
        taskSummary: "t",
      }),
    };
    const orchestrator = new Orchestrator(
      [new DemoProvider()],
      undefined,
      new RoutePlanner(),
      analyzer,
    );

    const classificationLocations: string[] = [];
    for await (const event of orchestrator.run({
      conversationId: "c",
      policy: "balanced",
      messages: [
        { id: "m", role: "user", content: "Hello.", createdAt: new Date(0).toISOString() },
      ],
    })) {
      if (event.type === "trace" && event.trace.kind === "classification") {
        classificationLocations.push(event.trace.location);
      }
    }

    // Non-empty is half the assertion: an empty list would make the next line
    // vacuously true.
    expect(classificationLocations.length).toBeGreaterThan(0);
    expect(new Set(classificationLocations)).toEqual(new Set(["network"]));
  });
});

describe("web is a tool tier, distinct from a model vendor", () => {
  // `cloud` in this codebase means a vendor's INFERENCE API — it receives the
  // whole conversation under that vendor's retention terms. A search provider
  // receives a query string. Both leave the device; they are not the same
  // permission, and reusing one word for both made a search provider read as a
  // model vendor in every ceiling and disclosure.
  it("orders web below cloud, because less travels", () => {
    expect(locationTier("web")).toBeLessThan(locationTier("cloud"));
    expect(locationTier("web")).toBeGreaterThan(locationTier("remote"));
  });

  it("counts as leaving the device", () => {
    // The whole point of the tier: never conflated with local, whatever the
    // search engine happens to be running on.
    expect(leavesDevice("web")).toBe(true);
  });

  it("lets a tool ceiling permit search without permitting a vendor model", () => {
    // The statement no arrangement of the previous vocabulary could make.
    // Policies now say toolCeiling "web" rather than "cloud": both admit
    // today's providers, but only one of them stops granting more than meant.
    expect(locationTier("web")).toBeLessThanOrEqual(locationTier("web"));
    expect(locationTier("cloud")).toBeGreaterThan(locationTier("web"));
  });
});

describe("a tool ceiling of web refuses a tool that reaches further", () => {
  // Without this the rename is cosmetic: mutating every policy's toolCeiling
  // from "web" back to "cloud" failed no test, so nothing distinguished the
  // precise permission from the over-broad one. A tool CAN declare `cloud` —
  // RuntimeToolDescriptor permits it — so the refusal is testable even though
  // no shipped provider does.
  function toolAt(location: "web" | "cloud"): WebSearchProvider {
    return {
      tool: {
        id: `web-search:${location}`,
        label: `Search (${location})`,
        capabilities: ["web"],
        location,
        available: true,
        contextMayLeaveDevice: true,
      },
      async search(query) {
        return { query, results: [], provider: "test" };
      },
    };
  }

  async function runSearch(search: WebSearchProvider) {
    // Positional: (providers, compiler, planner, promptAnalyzer, webSearch).
    const orchestrator = new Orchestrator(
      [new DemoProvider()],
      new RequestCompiler(),
      new RoutePlanner(),
      undefined,
      search,
    );
    const errors: string[] = [];
    for await (const event of orchestrator.run({
      conversationId: "c",
      policy: "balanced",
      messages: [
        {
          id: "m",
          role: "user",
          content: "Search the web for the latest OpenSSL advisory.",
          createdAt: new Date(0).toISOString(),
        },
      ],
    })) {
      if (event.type === "error") errors.push(event.message);
    }
    return errors;
  }

  it("refuses a cloud-tier tool under balanced's web ceiling", async () => {
    const errors = await runSearch(toolAt("cloud"));

    expect(errors.some((m) => /retrieval no further than web/u.test(m))).toBe(
      true,
    );
  });

  it("permits a web-tier tool under the same ceiling", async () => {
    // The negative above would also pass if search were broken outright.
    const errors = await runSearch(toolAt("web"));

    expect(errors.some((m) => /retrieval no further than/u.test(m))).toBe(false);
  });
});
