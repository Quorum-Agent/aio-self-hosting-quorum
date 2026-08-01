import { describe, expect, it } from "vitest";
import { POLICIES } from "./policies.js";
import {
  LOCATION_NOUNS,
  inferenceReachClaim,
  nextLocationBeyond,
  policiesWithoutTools,
  policyDescription,
  renderReachClaim,
  toolReachSentence,
} from "./policy-copy.js";
import {
  EXECUTION_LOCATIONS,
  locationTier,
  type ExecutionLocation,
  type PolicyDefinition,
} from "./types.js";

/** Which tiers a piece of copy actually names. */
function nounsPresent(text: string): ExecutionLocation[] {
  return EXECUTION_LOCATIONS.filter((location) =>
    text.includes(LOCATION_NOUNS[location]),
  );
}

/**
 * The tiers a policy's copy is *entitled* to name: each ceiling, and the
 * nearest tier each one excludes. Computed from the policy's own values, so
 * this is not a second list to keep in step with the first.
 */
function permittedNouns(policy: PolicyDefinition): ExecutionLocation[] {
  const named: ExecutionLocation[] = [
    policy.inferenceCeiling,
    nextLocationBeyond(policy.inferenceCeiling),
    policy.toolCeiling === "none" ? undefined : policy.toolCeiling,
    policy.toolCeiling === "none"
      ? undefined
      : nextLocationBeyond(policy.toolCeiling),
  ].filter((location): location is ExecutionLocation => location !== undefined);
  return EXECUTION_LOCATIONS.filter((location) => named.includes(location));
}

describe("the tier vocabulary", () => {
  // Every substring assertion below is worthless if two nouns overlap: a test
  // checking that "your local network" is absent would pass while the copy said
  // it, if some other tier's noun contained the phrase. Assert the property the
  // rest of the file leans on rather than assuming it.
  it("gives every tier a distinct noun that contains no other tier's noun", () => {
    for (const location of EXECUTION_LOCATIONS) {
      const noun = LOCATION_NOUNS[location];
      expect(noun.length).toBeGreaterThan(0);
      for (const other of EXECUTION_LOCATIONS) {
        if (other === location) continue;
        expect(noun).not.toContain(LOCATION_NOUNS[other]);
      }
    }
  });

  it("reads the tier order rather than restating it", () => {
    for (const [index, location] of EXECUTION_LOCATIONS.entries()) {
      expect(nextLocationBeyond(location)).toBe(EXECUTION_LOCATIONS[index + 1]);
    }
    const furthest = EXECUTION_LOCATIONS[EXECUTION_LOCATIONS.length - 1]!;
    expect(nextLocationBeyond(furthest)).toBeUndefined();
  });
});

describe("a reach claim", () => {
  it("permits exactly the ceiling and excludes exactly the tier past it", () => {
    for (const ceiling of EXECUTION_LOCATIONS) {
      const claim = inferenceReachClaim({ inferenceCeiling: ceiling });
      expect(claim.permittedUpTo).toBe(ceiling);
      expect(claim.excludedFrom).toBe(EXECUTION_LOCATIONS[locationTier(ceiling) + 1]);
    }
  });

  it("names the permitted tier and the excluded one, and no others", () => {
    for (const ceiling of EXECUTION_LOCATIONS) {
      const sentence = renderReachClaim(
        "Models",
        inferenceReachClaim({ inferenceCeiling: ceiling }),
      );
      const expected = [ceiling, nextLocationBeyond(ceiling)].filter(
        (location): location is ExecutionLocation => location !== undefined,
      );
      expect(nounsPresent(sentence)).toEqual(
        EXECUTION_LOCATIONS.filter((location) => expected.includes(location)),
      );
    }
  });

  it("distinguishes every tier from every other", () => {
    const rendered = EXECUTION_LOCATIONS.map((ceiling) =>
      renderReachClaim("Models", inferenceReachClaim({ inferenceCeiling: ceiling })),
    );
    expect(new Set(rendered).size).toBe(EXECUTION_LOCATIONS.length);
  });

  it("states that no tool runs when the tool ceiling is none, without naming a tier", () => {
    const sentence = toolReachSentence({ toolCeiling: "none" });
    expect(sentence).toBe("No tools run.");
    expect(nounsPresent(sentence)).toEqual([]);
  });
});

describe("every shipped policy", () => {
  const policies = Object.values(POLICIES);

  // The mutation this whole design defends against: someone writes a
  // description by hand again. A literal that contradicts its ceilings is the
  // defect; a literal that agrees with them today is the same defect waiting.
  it("carries a description computed from its own ceilings, never a literal", () => {
    for (const policy of policies) {
      expect(policy.description).toBe(policyDescription(policy));
    }
  });

  it("names only tiers its ceilings entitle it to name", () => {
    for (const policy of policies) {
      expect({
        policy: policy.id,
        named: nounsPresent(policy.description),
      }).toEqual({
        policy: policy.id,
        named: permittedNouns(policy),
      });
    }
  });

  // `intent` is the hand-written half. It stays safe only while it makes no
  // claim about reach — otherwise the generated sentence and the sentence
  // beside it can disagree, which is the original defect with an extra step.
  it("keeps reach claims out of the hand-written intent", () => {
    for (const policy of policies) {
      expect({ policy: policy.id, named: nounsPresent(policy.intent) }).toEqual({
        policy: policy.id,
        named: [],
      });
    }
  });

  it("states the tool half in terms of the tool ceiling alone", () => {
    for (const policy of policies) {
      expect(policy.description).toContain(toolReachSentence(policy));
    }
  });
});

describe("offline, which has had this sentence wrong twice", () => {
  const offline = POLICIES.offline;

  it("does not offer the local network that its ceiling excludes", () => {
    // The shipped defect: "Run every computation on this machine, including the
    // local network", against `inferenceCeiling: "device"`. The word that broke
    // it was "including" — correct while the sentence was a negative, and
    // silently attached to what is *permitted* once it was rewritten positive.
    expect(offline.inferenceCeiling).toBe("device");
    expect(offline.description).not.toContain(LOCATION_NOUNS.network);
    expect(offline.description).not.toContain("including");
  });

  it("says what it does run and what it excludes, separately", () => {
    expect(offline.description).toContain(LOCATION_NOUNS.device);
    expect(offline.description).toContain(
      `That excludes ${LOCATION_NOUNS.local} and everything past it.`,
    );
  });
});

describe("naming which policies run no tools", () => {
  // A fixture that can reach the wrong answer: it contains a policy that must
  // be left out. A list of tool-free policies only is satisfied by "return
  // everything", which is precisely the bug being guarded against.
  const fixture = [
    { label: "Private", toolCeiling: "none" as const },
    { label: "Balanced", toolCeiling: "web" as const },
    { label: "Offline", toolCeiling: "none" as const },
  ];

  it("names the tool-free policies and omits the rest", () => {
    expect(policiesWithoutTools(fixture)).toEqual(["Private", "Offline"]);
  });

  it("returns nothing when every policy runs tools", () => {
    expect(
      policiesWithoutTools([{ label: "Balanced", toolCeiling: "web" }]),
    ).toEqual([]);
  });

  // Deliberately not `expect(result).toEqual(POLICIES.filter(same predicate))`,
  // which would compute the answer the same way the function does and pass for
  // any implementation of it. What is asserted is that the shipped set is a
  // *proper* subset: some policy is named, some policy is left out.
  it("splits the shipped policies rather than returning all or none", () => {
    const named = policiesWithoutTools(Object.values(POLICIES));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(Object.values(POLICIES).length);
    expect(named).toContain(POLICIES.offline.label);
    expect(named).not.toContain(POLICIES.balanced.label);
  });
});
