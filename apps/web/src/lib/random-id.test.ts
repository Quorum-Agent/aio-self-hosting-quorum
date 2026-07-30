import { afterEach, describe, expect, it, vi } from "vitest";

import { createRandomId } from "./random-id";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubInsecureContextCrypto(): void {
  const originalCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
  });
}

describe("createRandomId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a v4 UUID when crypto.randomUUID is available", () => {
    expect(createRandomId()).toMatch(UUID_PATTERN);
  });

  it("returns a v4 UUID without crypto.randomUUID, as in insecure contexts", () => {
    stubInsecureContextCrypto();
    expect(createRandomId()).toMatch(UUID_PATTERN);
  });

  it("returns unique identifiers in the insecure-context fallback", () => {
    stubInsecureContextCrypto();
    const identifiers = new Set(
      Array.from({ length: 100 }, () => createRandomId()),
    );
    expect(identifiers.size).toBe(100);
  });
});
