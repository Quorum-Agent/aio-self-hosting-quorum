import { describe, expect, it } from "vitest";

import source from "./use-modal-surface.js?raw";

// The hook's behaviour is verified against a real browser; these guard the
// decisions inside it that a refactor would plausibly undo, and that no
// DOM-less test can observe.
describe("useModalSurface", () => {
  it("does not use offsetParent to decide what is focusable", () => {
    // offsetParent is null for every descendant of a position: fixed element,
    // which is exactly what these drawers become once they overlay the
    // conversation — the filter silently matched nothing.
    // Matches use, not the comment explaining why it is avoided.
    expect(source).not.toMatch(/\.offsetParent\s*[!=]==/u);
    expect(source).toContain("getClientRects()");
  });

  it("retries the initial focus after the drawer has finished moving", () => {
    // focus() is ignored while the element is still transitioning in, so a
    // single attempt on the next frame lands nowhere.
    expect(source).toContain("DRAWER_TRANSITION_MS");
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("setTimeout");
  });

  it("restores focus to wherever it came from", () => {
    expect(source).toContain("restoreFocusTo");
    expect(source).toContain("isConnected");
  });

  it("leaves the settings dialog to manage its own background", () => {
    // It opens above a drawer and already inerts the shell itself; inerting it
    // from here would strand focus when the drawer closes underneath it.
    expect(source).toContain("settings-backdrop");
  });
});
