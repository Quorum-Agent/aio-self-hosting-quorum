import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownMessage } from "./MarkdownMessage";

describe("MarkdownMessage", () => {
  it("renders headings, lists, tables, and copyable fenced code", () => {
    const markup = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          "## Example",
          "",
          "- one",
          "- two",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| local | yes |",
          "",
          "```ts",
          "const ready = true;",
          "```",
        ].join("\n")}
      />,
    );

    expect(markup).toContain("<h2>Example</h2>");
    expect(markup).toContain("<li>one</li>");
    expect(markup).toContain("<table>");
    expect(markup).toContain("aria-label=\"Copy code\"");
    expect(markup).toContain("const ready = true;");
  });

  it("does not turn raw HTML or unsafe links into executable markup", () => {
    const markup = renderToStaticMarkup(
      <MarkdownMessage
        content={'<script>alert("x")</script> [click](javascript:alert(1))'}
      />,
    );

    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("href=");
  });
});
