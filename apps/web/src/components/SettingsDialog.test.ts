import { describe, expect, it } from "vitest";

import { POLICIES, type PolicyDefinition } from "@quorum/core";

import {
  canSaveWebSearchSettings,
  searchlessPolicyNote,
} from "./SettingsDialog";

describe("web-search settings submission", () => {
  it("allows disabling search even when the selected provider is unconfigured", () => {
    expect(canSaveWebSearchSettings(true, false, false, false)).toBe(true);
  });

  it("never presents an actionable Save control that the handler will ignore", () => {
    expect(canSaveWebSearchSettings(false, true, true, false)).toBe(false);
    expect(canSaveWebSearchSettings(true, true, false, false)).toBe(false);
    expect(canSaveWebSearchSettings(true, true, true, true)).toBe(false);
    expect(canSaveWebSearchSettings(true, true, true, false)).toBe(true);
  });
});

describe("the note about which policies never search", () => {
  function policy(
    label: string,
    toolCeiling: PolicyDefinition["toolCeiling"],
  ): PolicyDefinition {
    return { ...POLICIES.balanced, label, toolCeiling };
  }

  // The fixture has to be able to produce the wrong answer: it contains a
  // policy that searches, so "name everything" is distinguishable from "name
  // the tool-free ones".
  // `LAN tools` is the row that gives this test teeth. It permits tools, so a
  // predicate of `toolCeiling === "none"` — which is what this was before a
  // reviewer caught it asking the wrong question — would leave it out of a
  // sentence that reads as the complete list. Web search runs at `web`, which
  // that ceiling does not reach.
  it("names every policy the search tool cannot run under", () => {
    expect(
      searchlessPolicyNote([
        policy("Private", "none"),
        policy("Balanced", "web"),
        policy("LAN tools", "network"),
        policy("Offline", "none"),
      ]),
    ).toBe("Private, LAN tools and Offline do not search.");
  });

  it("agrees in number with one policy", () => {
    expect(
      searchlessPolicyNote([policy("Private", "none"), policy("Balanced", "web")]),
    ).toBe("Private does not search.");
  });

  it("claims nothing before the runtime has said what the policies are", () => {
    expect(searchlessPolicyNote(undefined)).toBe("");
    expect(searchlessPolicyNote([])).toBe("");
  });

  it("makes no claim when every policy may search", () => {
    expect(
      searchlessPolicyNote([policy("Balanced", "web"), policy("Quality", "cloud")]),
    ).toBe("");
  });
});
