import { describe, expect, it } from "vitest";

import { safeDisplayText } from "./safe-text.js";

describe("text placed into the interface from elsewhere", () => {
  // The reason this is shared rather than private to the orchestrator: a
  // second caller now needs it. A subprocess log tail is exactly the kind of
  // text that carries controls, and it reaches the inspector verbatim.
  it("removes C0 and C1 controls that would break the surrounding markup", () => {
    expect(safeDisplayText("load\u0000 failed\u001b[31m\u009d now")).toBe(
      "load failed [31m now",
    );
  });

  it("removes the format characters that let text reorder itself", () => {
    // A right-to-left override in a log line reverses everything after it, so
    // a path or an error can be made to read as something else entirely.
    expect(safeDisplayText("error \u202ednuof ton elif\u202c here")).toBe(
      "error dnuof ton elif here",
    );
  });

  it("collapses whitespace so a multi-line tail stays one readable line", () => {
    expect(safeDisplayText("first\n\n   second\tthird")).toBe(
      "first second third",
    );
  });

  it("bounds the length at the caller's limit", () => {
    expect(safeDisplayText("x".repeat(50), 10)).toBe("x".repeat(10));
    expect(safeDisplayText("x".repeat(500)).length).toBe(240);
  });
});
