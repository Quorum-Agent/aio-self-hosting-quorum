import { describe, expect, it } from "vitest";

import { canSaveWebSearchSettings } from "./SettingsDialog";

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
