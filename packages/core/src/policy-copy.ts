import {
  EXECUTION_LOCATIONS,
  locationTier,
  type ExecutionLocation,
  type PolicyDefinition,
} from "./types.js";

/**
 * How a policy's reach is described to a user.
 *
 * This module exists because of a defect class rather than a feature. Every
 * behaviour in this repository is mutation-verified; user-visible copy was not,
 * and copy stating reach was wrong three separate ways in one day — a search
 * provider claiming queries stayed on the device, a composer claiming a policy
 * disabled network access, and the `offline` card stating the *opposite* of the
 * ceiling it describes ("Run every computation on this machine, including the
 * local network", against `inferenceCeiling: "device"`).
 *
 * The last one is the instructive one. The sentence had been correct as a
 * negative — "Disable every network operation, including local network
 * endpoints" — and rewriting it into positive framing moved what "including"
 * attached to, from what is *disabled* to what is *permitted*, without changing
 * a word of it. No reviewer caught it; the person who wrote it had read, edited
 * and committed the line hours earlier.
 *
 * A test could not have caught that either, at least not honestly: asserting
 * that a hand-written sentence "matches" a ceiling means parsing prose, and a
 * prose matcher that recognises nothing passes silently — the vacuity trap this
 * repository has now hit five times.
 *
 * So the reach half of every policy description is **computed from the ceiling
 * it describes**. A description cannot contradict a value it is derived from.
 * What is left hand-written is the *intent* — what the mode is for — which
 * makes no claim about reach and therefore cannot invert one.
 *
 * The guard that remains is `policyDescription` being the only way a
 * description is produced (see `policies.ts` and its test): reintroducing a
 * literal string is the mutation this design is defended against.
 */

/**
 * One bare noun phrase per tier, used for both what a ceiling permits and what
 * it excludes.
 *
 * Deliberately one table rather than two. A "permits" phrasing and an
 * "excludes" phrasing maintained separately is the same *one fact, two fields*
 * shape that produced most of the defects recorded in `REDTEAM-FINDINGS.md`.
 *
 * These must stay mutually distinct and non-overlapping — a tier whose noun
 * contains another tier's noun would make any substring assertion about them
 * meaningless. `policy-copy.test.ts` asserts that directly rather than trusting
 * it.
 */
export const LOCATION_NOUNS: Record<ExecutionLocation, string> = {
  device: "Quorum's own process",
  local: "a loopback server on this machine",
  network: "your local network",
  remote: "hardware you rent",
  web: "the public internet",
  cloud: "a vendor's API",
};

/**
 * The tier immediately beyond a ceiling — the nearest thing it excludes — or
 * `undefined` when the ceiling is already the furthest tier.
 *
 * Read from `EXECUTION_LOCATIONS` rather than written down, so adding a tier
 * cannot leave this describing the old neighbour.
 */
export function nextLocationBeyond(
  ceiling: ExecutionLocation,
): ExecutionLocation | undefined {
  return EXECUTION_LOCATIONS[locationTier(ceiling) + 1];
}

/**
 * The structured form of a reach sentence, so tests can assert what is claimed
 * without parsing the sentence back out of prose.
 */
export interface ReachClaim {
  /** The furthest tier permitted. Always the ceiling itself. */
  permittedUpTo: ExecutionLocation;
  /** The nearest excluded tier, absent only at the top of the order. */
  excludedFrom?: ExecutionLocation | undefined;
}

export function inferenceReachClaim(policy: {
  inferenceCeiling: ExecutionLocation;
}): ReachClaim {
  return {
    permittedUpTo: policy.inferenceCeiling,
    excludedFrom: nextLocationBeyond(policy.inferenceCeiling),
  };
}

/**
 * Render a reach claim as a sentence.
 *
 * "No further than X" is used for every tier because that is literally what a
 * ceiling is, and because it stays grammatical across all six nouns — phrasings
 * that need a preposition ("runs on", "runs in") do not, and a phrasing that
 * needs per-tier special-casing is a phrasing that can be special-cased wrongly.
 */
export function renderReachClaim(
  subject: string,
  claim: ReachClaim,
): string {
  const permitted = `${subject} run no further than ${LOCATION_NOUNS[claim.permittedUpTo]}.`;
  if (!claim.excludedFrom) {
    return permitted;
  }
  return `${permitted} That excludes ${LOCATION_NOUNS[claim.excludedFrom]} and everything past it.`;
}

/**
 * The tool half.
 *
 * `"none"` is total — no tool runs at all — so it takes no exclusion clause;
 * there is no nearest excluded tier when nothing is permitted. It is stated
 * separately from inference because the two ceilings are independent axes, and
 * a sentence covering both would have to pick one to be wrong about.
 */
export function toolReachSentence(policy: {
  toolCeiling: ExecutionLocation | "none";
}): string {
  if (policy.toolCeiling === "none") {
    return "No tools run.";
  }
  return renderReachClaim("Tools", {
    permittedUpTo: policy.toolCeiling,
    excludedFrom: nextLocationBeyond(policy.toolCeiling),
  });
}

export function inferenceReachSentence(policy: {
  inferenceCeiling: ExecutionLocation;
}): string {
  return renderReachClaim("Models", inferenceReachClaim(policy));
}

/**
 * The user-visible description of a policy: hand-written intent, then computed
 * reach.
 *
 * `intent` must not make a reach claim of its own — that would reopen exactly
 * the gap this module closes. `policies.test.ts` enforces it by asserting no
 * tier noun appears in any policy's intent.
 */
export function policyDescription(policy: {
  intent: string;
  inferenceCeiling: ExecutionLocation;
  toolCeiling: ExecutionLocation | "none";
}): string {
  return [
    policy.intent,
    inferenceReachSentence(policy),
    toolReachSentence(policy),
  ].join(" ");
}

/**
 * Which policies run no tools, named rather than assumed.
 *
 * The settings dialog previously read "Private and Offline policies never
 * search" — two policy names hard-coded beside the field that decides it. True
 * today, silently false the moment a ceiling moves or a policy is added, and
 * the same shape as the copy defects above.
 */
export function policiesWithoutTools(
  policies: readonly Pick<PolicyDefinition, "label" | "toolCeiling">[],
): string[] {
  return policies
    .filter((policy) => policy.toolCeiling === "none")
    .map((policy) => policy.label);
}
