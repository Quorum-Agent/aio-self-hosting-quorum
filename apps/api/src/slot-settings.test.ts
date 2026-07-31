import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_SLOT_SETTINGS,
  findStaleAssignments,
  parseSlotSettings,
  readSlotSettings,
  settingsFilePath,
  slotSource,
  writeSlotSettings,
  type SlotSettings,
} from "./slot-settings.js";

const temporaryDirectories: string[] = [];

function temporaryDataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quorum-slot-settings-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseSlotSettings", () => {
  it("keeps a well-formed assignment", () => {
    expect(
      parseSlotSettings({
        version: 1,
        slots: { coding: { model: "qwen3-coder:7b", contextWindow: 8_192 } },
      }),
    ).toEqual({
      version: 1,
      slots: { coding: { model: "qwen3-coder:7b", contextWindow: 8_192 } },
    });
  });

  it("drops slot ids it does not recognise", () => {
    // An older or newer settings file naming a slot this build does not have
    // must not become a model. The role list is the authority, not the file.
    const parsed = parseSlotSettings({
      version: 1,
      slots: {
        coding: { model: "kept" },
        vision: { model: "not-a-role-in-this-build" },
        __proto__: { model: "hostile" },
      },
    });
    expect(Object.keys(parsed.slots)).toEqual(["coding"]);
  });

  it("drops assignments that cannot be acted on", () => {
    const parsed = parseSlotSettings({
      version: 1,
      slots: {
        general: { model: "   " },
        coding: { model: 42 },
        reasoning: { notAModel: true },
      },
    });
    expect(parsed.slots).toEqual({});
  });

  it("trims the model name and drops an unusable context window", () => {
    const parsed = parseSlotSettings({
      version: 1,
      slots: { general: { model: "  spaced:7b  ", contextWindow: -1 } },
    });
    expect(parsed.slots.general).toEqual({ model: "spaced:7b" });
  });

  it("returns empty settings for values that are not objects", () => {
    expect(parseSlotSettings(null)).toEqual(EMPTY_SLOT_SETTINGS);
    expect(parseSlotSettings("nope")).toEqual(EMPTY_SLOT_SETTINGS);
    expect(parseSlotSettings({ slots: "nope" })).toEqual(EMPTY_SLOT_SETTINGS);
  });
});

describe("readSlotSettings", () => {
  it("returns empty settings when no file exists", () => {
    expect(readSlotSettings(temporaryDataDirectory())).toEqual(
      EMPTY_SLOT_SETTINGS,
    );
  });

  it("returns empty settings rather than throwing on malformed JSON", () => {
    // A settings file can be hand-edited or left truncated by a crash. Losing
    // an assignment is recoverable; refusing to start is not.
    const directory = temporaryDataDirectory();
    writeFileSync(settingsFilePath(directory), "{ this is not json");
    expect(() => readSlotSettings(directory)).not.toThrow();
    expect(readSlotSettings(directory)).toEqual(EMPTY_SLOT_SETTINGS);
  });

  it("round-trips what was written", () => {
    const directory = temporaryDataDirectory();
    const settings: SlotSettings = {
      version: 1,
      slots: { reasoning: { model: "deepseek-r1:8b", contextWindow: 32_768 } },
    };
    writeSlotSettings(directory, settings);
    expect(readSlotSettings(directory)).toEqual(settings);
  });
});

describe("writeSlotSettings", () => {
  it("creates the data directory and leaves no temporary file behind", () => {
    const directory = join(temporaryDataDirectory(), "nested", "var");
    writeSlotSettings(directory, {
      version: 1,
      slots: { general: { model: "a:1b" } },
    });
    expect(JSON.parse(readFileSync(settingsFilePath(directory), "utf8"))).toEqual(
      { version: 1, slots: { general: { model: "a:1b" } } },
    );
    expect(() =>
      readFileSync(`${settingsFilePath(directory)}.tmp`, "utf8"),
    ).toThrow();
  });
});

describe("slotSource", () => {
  it("reports the environment even when a stored assignment exists", () => {
    // The interface uses this to avoid offering an edit that cannot take
    // effect. If it reported "settings" here, saving would appear to work and
    // the running config would keep the environment's value.
    expect(slotSource("from-env", { model: "from-settings" })).toBe(
      "environment",
    );
  });

  it("reports settings only when the environment is silent", () => {
    expect(slotSource(undefined, { model: "from-settings" })).toBe("settings");
    expect(slotSource(undefined, undefined)).toBe("default");
  });

  it("treats an empty environment value as set, not absent", () => {
    expect(slotSource("", { model: "from-settings" })).toBe("environment");
  });
});

describe("findStaleAssignments", () => {
  const settings: SlotSettings = {
    version: 1,
    slots: {
      general: { model: "present:9b" },
      coding: { model: "deleted:7b" },
    },
  };

  it("reports an assignment naming a model the runtime does not have", () => {
    expect(findStaleAssignments(settings, ["present:9b", "other:3b"])).toEqual([
      { slot: "coding", model: "deleted:7b" },
    ]);
  });

  it("reports nothing when every assignment is satisfied", () => {
    expect(
      findStaleAssignments(settings, ["present:9b", "deleted:7b"]),
    ).toEqual([]);
  });

  it("reports nothing when the inventory could not be read", () => {
    // The discriminating case. An empty inventory means the runtime did not
    // answer, not that every saved model vanished. Reporting these as stale
    // would fire the warning on every startup where the runtime was slow,
    // which is how a warning stops being read. Same reason the GGUF load gate
    // separates INCONCLUSIVE from REJECTED.
    //
    // The fixture can reach the wrong answer: both assignments below are
    // absent from the empty inventory, so a version that skipped this check
    // would return two findings rather than none.
    expect(Object.keys(settings.slots)).toHaveLength(2);
    expect(findStaleAssignments(settings, [])).toEqual([]);
  });

  it("matches model names case-insensitively", () => {
    // `modelIsInstalled` compares case-sensitively while the managed runtime
    // lowercases, which has already produced a model that passes startup and
    // then fails discovery. Do not add a third convention.
    expect(findStaleAssignments(settings, ["PRESENT:9B", "DELETED:7B"])).toEqual(
      [],
    );
  });
});
