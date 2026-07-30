import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("exposes a working web-search settings entry", () => {
    const onSettings = vi.fn();
    const markup = renderToStaticMarkup(
      <Sidebar
        conversations={[]}
        activeId="conversation-1"
        disabled={false}
        onNew={() => undefined}
        onSelect={() => undefined}
        onSettings={onSettings}
      />,
    );

    expect(markup).toContain("Web search settings");
    expect(markup).not.toContain("disabled");
  });

  it("disables settings while a request is mutating the active runtime", () => {
    const markup = renderToStaticMarkup(
      <Sidebar
        conversations={[]}
        activeId="conversation-1"
        disabled
        onNew={() => undefined}
        onSelect={() => undefined}
        onSettings={() => undefined}
      />,
    );

    expect(markup).toContain("class=\"sidebar-settings\"");
    expect(markup).toContain("disabled");
  });
});
