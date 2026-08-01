import { describe, expect, it } from "vitest";
import { POLICIES } from "./policies.js";
import {
  LOCATION_NOUNS,
  inferenceReachClaim,
  nextLocationBeyond,
  policiesWithoutSearch,
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

/**
 * What each tier's noun has to *mean*, stated independently of what it says.
 *
 * This table exists because an external reviewer defeated the first version of
 * this file. Every other assertion here indexes `LOCATION_NOUNS` on both sides,
 * so swapping the `device` and `local` entries left the whole suite green while
 * the offline card claimed models run "no further than a loopback server" — the
 * original defect, reproduced exactly, one layer below where it was fixed. The
 * tests locked consistency with the generator, not truth about the tiers.
 *
 * So the oracle is a different one: not the phrase, but the concept the phrase
 * must name and the concepts it must not. Rewording a noun while keeping its
 * meaning passes. Swapping two of them cannot.
 */
const TIER_MEANING: Record<
  ExecutionLocation,
  { names: RegExp; notThese: RegExp }
> = {
  device: { names: /quorum/i, notThese: /loopback|network|internet|rent|vendor/i },
  local: { names: /loopback/i, notThese: /local network|internet|rent|vendor/i },
  network: { names: /local network/i, notThese: /loopback|internet|rent|vendor/i },
  remote: { names: /rent/i, notThese: /loopback|local network|internet|vendor/i },
  web: { names: /public internet/i, notThese: /loopback|local network|rent|vendor/i },
  cloud: { names: /vendor/i, notThese: /loopback|local network|rent|public internet/i },
};

describe("the tier vocabulary", () => {
  it("says of each tier what that tier means, and nothing another tier means", () => {
    for (const location of EXECUTION_LOCATIONS) {
      const noun = LOCATION_NOUNS[location];
      expect({ location, names: TIER_MEANING[location].names.test(noun) }).toEqual({
        location,
        names: true,
      });
      expect({
        location,
        borrows: TIER_MEANING[location].notThese.test(noun),
      }).toEqual({ location, borrows: false });
    }
  });

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

  // The other half of the shared-oracle problem: naming the right two tiers is
  // not the same as attaching them to the right clauses. A renderer that said
  // "Models run only beyond X" or hung "they do not reach" on the *permitted*
  // noun would name exactly the same tiers and pass every assertion above.
  it("attaches the permitted tier to what is allowed and the excluded tier to what is not", () => {
    for (const ceiling of EXECUTION_LOCATIONS) {
      const excluded = nextLocationBeyond(ceiling);
      if (!excluded) continue;
      const sentence = renderReachClaim(
        "Models",
        inferenceReachClaim({ inferenceCeiling: ceiling }),
      );
      const permittedAt = sentence.indexOf(LOCATION_NOUNS[ceiling]);
      const denialAt = sentence.indexOf("do not reach");
      const excludedAt = sentence.indexOf(LOCATION_NOUNS[excluded]);
      expect(sentence).toContain(`run no further than ${LOCATION_NOUNS[ceiling]}`);
      expect(permittedAt).toBeGreaterThanOrEqual(0);
      expect(denialAt).toBeGreaterThan(permittedAt);
      expect(excludedAt).toBeGreaterThan(denialAt);
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
      `do not reach ${LOCATION_NOUNS.local}`,
    );
  });
});

describe("naming which policies cannot search", () => {
  // A fixture that can reach the wrong answer: it contains a policy that must
  // be left out. A list of tool-free policies only is satisfied by "return
  // everything", which is precisely the bug being guarded against.
  //
  // `network` is the row that matters. It permits tools, so a filter on
  // `toolCeiling === "none"` — which is what this function did until a reviewer
  // pointed out it was answering a different question — leaves it off a
  // sentence that presents itself as the complete list. It cannot run a web
  // search: the search tool is `web`, which is further out.
  const fixture = [
    { label: "Private", toolCeiling: "none" as const },
    { label: "Balanced", toolCeiling: "web" as const },
    { label: "LAN tools", toolCeiling: "network" as const },
    { label: "Offline", toolCeiling: "none" as const },
  ];

  it("names every policy the search tool cannot run under, not just the tool-free ones", () => {
    expect(policiesWithoutSearch(fixture).map((policy) => policy.label)).toEqual([
      "Private",
      "LAN tools",
      "Offline",
    ]);
  });

  it("returns nothing when every policy permits the search tool's tier", () => {
    expect(
      policiesWithoutSearch([{ label: "Balanced", toolCeiling: "web" }]),
    ).toEqual([]);
  });

  it("reads the search tool's own location rather than assuming one", () => {
    // A policy that permits `web` tools still cannot run a `cloud` one — which
    // is what a SearXNG instance is classified as, because it proxies the query
    // onward. Passing the location in is what lets the sentence stay true if
    // the configured provider sits further out than the default.
    expect(
      policiesWithoutSearch(
        [{ label: "Balanced", toolCeiling: "web" }],
        "cloud",
      ).map((policy) => policy.label),
    ).toEqual(["Balanced"]);
  });

  // Deliberately not `expect(result).toEqual(POLICIES.filter(same predicate))`,
  // which would compute the answer the same way the function does and pass for
  // any implementation of it. What is asserted is that the shipped set is a
  // *proper* subset: some policy is named, some policy is left out.
  it("splits the shipped policies rather than returning all or none", () => {
    const named = policiesWithoutSearch(Object.values(POLICIES)).map(
      (policy) => policy.label,
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(Object.values(POLICIES).length);
    expect(named).toContain(POLICIES.offline.label);
    expect(named).not.toContain(POLICIES.balanced.label);
  });
});
