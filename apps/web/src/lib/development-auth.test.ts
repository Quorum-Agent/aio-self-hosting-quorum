import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  isNetworkDevelopmentAuthorizationValid,
  isOwnDevelopmentOrigin,
  MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH,
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
        "x".repeat(MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH - 1),
      ),
    ).toBe(false);
  });

  it("vouches only for the development server's own origin", () => {
    const host = "192.168.1.10:5173";
    expect(isOwnDevelopmentOrigin(`http://${host}`, host)).toBe(true);
    // No Origin at all is a non-browser caller; the API allows those already.
    expect(isOwnDevelopmentOrigin(undefined, host)).toBe(true);
  });

  it("refuses to launder a foreign origin past the API's own check", () => {
    const host = "192.168.1.10:5173";
    expect(isOwnDevelopmentOrigin("https://evil.example", host)).toBe(false);
    expect(isOwnDevelopmentOrigin("http://evil.example", host)).toBe(false);
    // A look-alike that merely contains the host must not pass either.
    expect(
      isOwnDevelopmentOrigin(`http://evil.example/${host}`, host),
    ).toBe(false);
    expect(isOwnDevelopmentOrigin(`http://${host}`, undefined)).toBe(false);
  });

  it("accepts a memorable password at the documented minimum", () => {
    const minimumPassword = "x".repeat(
      MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH,
    );
    expect(
      isNetworkDevelopmentAuthorizationValid(
        basicAuthorization(
          NETWORK_DEVELOPMENT_USERNAME,
          minimumPassword,
        ),
        minimumPassword,
      ),
    ).toBe(true);
  });
});
