import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  isNetworkDevelopmentAuthorizationValid,
  NETWORK_DEVELOPMENT_USERNAME,
} from "./development-auth.js";

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("network development authorization", () => {
  const password = "correct-horse-battery-staple";

  it("accepts only the configured Quorum credentials", () => {
    expect(
      isNetworkDevelopmentAuthorizationValid(
        basicAuthorization(NETWORK_DEVELOPMENT_USERNAME, password),
        password,
      ),
    ).toBe(true);
    expect(
      isNetworkDevelopmentAuthorizationValid(
        basicAuthorization(NETWORK_DEVELOPMENT_USERNAME, "wrong-password-value"),
        password,
      ),
    ).toBe(false);
    expect(
      isNetworkDevelopmentAuthorizationValid(
        basicAuthorization("someone-else", password),
        password,
      ),
    ).toBe(false);
  });

  it("rejects missing, malformed, and undersized credentials", () => {
    expect(
      isNetworkDevelopmentAuthorizationValid(undefined, password),
    ).toBe(false);
    expect(
      isNetworkDevelopmentAuthorizationValid("Bearer not-basic", password),
    ).toBe(false);
    expect(
      isNetworkDevelopmentAuthorizationValid(
        basicAuthorization(NETWORK_DEVELOPMENT_USERNAME, "too-short"),
        "too-short",
      ),
    ).toBe(false);
  });
});
