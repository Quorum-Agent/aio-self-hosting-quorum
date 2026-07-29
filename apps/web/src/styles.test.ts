/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match?.[1]) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

describe("conversation layout", () => {
  it("constrains the application grid to the viewport", () => {
    expect(declarations(".app-shell")).toContain(
      "grid-template-rows: minmax(0, 1fr);",
    );
    expect(declarations(".app-shell")).toContain("overflow: hidden;");
    expect(declarations(".main")).toContain("min-height: 0;");
    expect(declarations(".main")).toContain("overflow: hidden;");
  });

  it("makes the conversation the vertical scroll owner", () => {
    expect(declarations(".conversation")).toContain("overflow-y: auto;");
    expect(declarations(".conversation")).toContain(
      "overscroll-behavior: contain;",
    );
    expect(declarations(".conversation")).toContain(
      "scrollbar-gutter: stable;",
    );
  });

  it("wraps long generated content instead of widening the viewport", () => {
    expect(declarations(".message p")).toContain("overflow-wrap: anywhere;");
  });
});

describe("response transparency controls", () => {
  it("styles the verbosity selector as a first-class control", () => {
    expect(styles).toContain(".verbosity-select");
  });

  it("visually distinguishes failed model attempts", () => {
    expect(declarations(".attempt-list")).toContain("list-style: none;");
    expect(declarations(".attempt-item")).toContain("display: grid;");
    expect(declarations(".attempt-item.is-failed .attempt-status")).toContain(
      "background: #9d5147;",
    );
  });

  it("gives detailed requests an expandable in-conversation activity rail", () => {
    expect(declarations(".execution-activity")).toContain(
      "border-bottom: 1px solid var(--line);",
    );
    expect(declarations(".activity-traces")).toContain("list-style: none;");
  });
});
