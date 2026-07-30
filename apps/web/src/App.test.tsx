import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import App from "./App";

function stubBrowserGlobals(): void {
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
  });
}

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders its first frame without secure-context APIs, as on plain-HTTP LAN", () => {
    stubBrowserGlobals();
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
    });
    const markup = renderToStaticMarkup(<App />);
    expect(markup.length).toBeGreaterThan(0);
    expect(markup).toContain("Quorum");
  });
});
