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

function mediaBlock(query: string): string {
  const start = styles.indexOf(`@media ${query}`);
  if (start < 0) throw new Error(`Missing media query ${query}`);
  const open = styles.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === "{") depth += 1;
    else if (styles[index] === "}") {
      depth -= 1;
      if (depth === 0) return styles.slice(open + 1, index);
    }
  }
  throw new Error(`Unterminated media query ${query}`);
}

function declarationsWithin(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`));
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

describe("mobile layout", () => {
  const mobile = mediaBlock("(max-width: 840px)");

  it("takes the side panels out of the grid flow", () => {
    expect(declarationsWithin(mobile, ".sidebar")).toContain(
      "position: fixed;",
    );
    expect(declarationsWithin(mobile, ".execution-panel")).toContain(
      "position: fixed;",
    );
  });

  it("leaves the main column a full-width track to occupy", () => {
    // With both panels fixed, .main is the only in-flow grid child. A leading
    // zero-width track would swallow it and blank the page, since .main also
    // sets overflow: hidden.
    const shell = declarationsWithin(mobile, ".app-shell");
    expect(shell).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(shell).not.toMatch(/grid-template-columns:\s*0\b/);
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

describe("web-search settings", () => {
  it("keeps the settings dialog inside the viewport with its own scroll owner", () => {
    expect(declarations(".settings-dialog")).toContain(
      "max-height: min(820px, 100%);",
    );
    expect(declarations(".settings-dialog")).toContain("overflow: hidden;");
    expect(declarations(".settings-scroll")).toContain("overflow-y: auto;");
  });

  it("keeps the working settings entry reachable below long conversation lists", () => {
    expect(declarations(".conversation-list")).toContain("flex: 1;");
    expect(declarations(".sidebar-settings")).toContain("display: flex;");
  });
});
