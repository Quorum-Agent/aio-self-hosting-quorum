import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { LocalModelRole } from "@quorum/core";

/**
 * Persistent, operator-chosen model assignments.
 *
 * Until this existed every model choice lived in the environment, so an
 * operator re-designated every launch and the app had no way to record a
 * choice made through its own interface.
 *
 * Two rules govern the whole module, and both exist because getting them
 * backwards produces silent misbehaviour rather than an error:
 *
 * 1. **The environment always wins.** Stored settings are a *fallback*
 *    consulted only where an environment variable is absent. The other
 *    precedence would change behaviour for every existing deployment and for
 *    the tests that set those variables, without anything appearing to fail.
 * 2. **A bad settings file must never prevent startup.** It is operator data
 *    that can be hand-edited, half-written by a crash, or left behind by an
 *    older version. Losing an assignment is recoverable; refusing to boot is
 *    the failure mode this repository already rejected for the managed
 *    runtime.
 */

export const SLOT_IDS = [
  "general",
  "coding",
  "reasoning",
] as const satisfies readonly LocalModelRole[];

export type SlotId = (typeof SLOT_IDS)[number];

/**
 * Fails to compile if `LocalModelRole` gains a role that `SLOT_IDS` does not
 * list. The guard reads the type it guards rather than restating its members,
 * so a new slot cannot be added upstream and silently go unpersisted here.
 */
type EveryRoleIsASlot =
  Exclude<LocalModelRole, SlotId> extends never ? true : never;
const _slotIdsAreExhaustive: EveryRoleIsASlot = true;
void _slotIdsAreExhaustive;

export interface SlotAssignment {
  model: string;
  contextWindow?: number;
}

export interface SlotSettings {
  version: 1;
  slots: Partial<Record<SlotId, SlotAssignment>>;
}

export const EMPTY_SLOT_SETTINGS: SlotSettings = { version: 1, slots: {} };

export function settingsFilePath(dataDirectory: string): string {
  return resolve(dataDirectory, "settings.json");
}

function isSlotId(value: string): value is SlotId {
  return (SLOT_IDS as readonly string[]).includes(value);
}

/**
 * Accepts only what it recognises. Unknown slot ids, non-string model names,
 * blank model names, and non-positive context windows are dropped rather than
 * carried forward — an assignment that cannot be acted on should not be
 * reported to the operator as configured.
 */
export function parseSlotSettings(raw: unknown): SlotSettings {
  if (typeof raw !== "object" || raw === null) return EMPTY_SLOT_SETTINGS;
  const slotsRaw = (raw as { slots?: unknown }).slots;
  if (typeof slotsRaw !== "object" || slotsRaw === null) {
    return EMPTY_SLOT_SETTINGS;
  }
  const slots: SlotSettings["slots"] = {};
  for (const [key, value] of Object.entries(slotsRaw as object)) {
    if (!isSlotId(key)) continue;
    if (typeof value !== "object" || value === null) continue;
    const { model, contextWindow } = value as {
      model?: unknown;
      contextWindow?: unknown;
    };
    if (typeof model !== "string") continue;
    const trimmed = model.trim();
    if (!trimmed) continue;
    slots[key] = {
      model: trimmed,
      ...(typeof contextWindow === "number" &&
      Number.isInteger(contextWindow) &&
      contextWindow > 0
        ? { contextWindow }
        : {}),
    };
  }
  return { version: 1, slots };
}

/** Never throws. A missing or unreadable file is an empty settings object. */
export function readSlotSettings(dataDirectory: string): SlotSettings {
  let contents: string;
  try {
    contents = readFileSync(settingsFilePath(dataDirectory), "utf8");
  } catch {
    return EMPTY_SLOT_SETTINGS;
  }
  try {
    return parseSlotSettings(JSON.parse(contents));
  } catch {
    return EMPTY_SLOT_SETTINGS;
  }
}

/**
 * Written through a temporary file and renamed into place, so a crash mid-write
 * cannot leave a truncated JSON document where the settings belong. Mode 0600
 * matches the managed runtime's handling of its own generated files.
 */
export function writeSlotSettings(
  dataDirectory: string,
  settings: SlotSettings,
): void {
  mkdirSync(dataDirectory, { recursive: true });
  const target = settingsFilePath(dataDirectory);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
}

export type SlotSource = "environment" | "settings" | "default";

/**
 * Where a slot's effective value came from.
 *
 * The interface needs this to avoid offering an edit that will not take
 * effect: a slot pinned by an environment variable cannot be changed by
 * saving a setting, and accepting the edit anyway would leave the operator
 * looking at a value the app is not using.
 */
export function slotSource(
  environmentValue: string | undefined,
  stored: SlotAssignment | undefined,
): SlotSource {
  if (environmentValue !== undefined) return "environment";
  if (stored) return "settings";
  return "default";
}

export interface StaleSlotAssignment {
  slot: SlotId;
  model: string;
}

/**
 * Stored assignments naming a model the runtime does not have.
 *
 * `availableModels` being empty means the inventory could not be read, not
 * that every assignment is broken, and this returns nothing in that case. The
 * distinction is the point: "your saved model is gone" and "I could not check
 * right now" must not render identically, or the warning stops being read.
 * The same separation is why the GGUF load gate reports INCONCLUSIVE rather
 * than folding contention into a rejection.
 */
export function findStaleAssignments(
  settings: SlotSettings,
  availableModels: readonly string[],
): StaleSlotAssignment[] {
  if (availableModels.length === 0) return [];
  const available = new Set(
    availableModels.map((name) => name.trim().toLowerCase()),
  );
  const stale: StaleSlotAssignment[] = [];
  for (const slot of SLOT_IDS) {
    const assignment = settings.slots[slot];
    if (!assignment) continue;
    if (!available.has(assignment.model.trim().toLowerCase())) {
      stale.push({ slot, model: assignment.model });
    }
  }
  return stale;
}
