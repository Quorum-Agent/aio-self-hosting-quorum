import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

export const NETWORK_DEVELOPMENT_USERNAME = "quorum";
export const MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH = 8;

// The proxy rewrites Origin so the loopback-only API accepts LAN requests.
// It may only do that for the dev server's own origin: rewriting a foreign
// one would launder it past the API's own origin check.
export function isOwnDevelopmentOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  return !origin || (host !== undefined && origin === `http://${host}`);
}

export function isNetworkDevelopmentAuthorizationValid(
  authorization: string | undefined,
  password: string,
): boolean {
  if (
    !authorization ||
    password.length < MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH
  ) {
    return false;
  }
  const expected = Buffer.from(
    `Basic ${Buffer.from(
      `${NETWORK_DEVELOPMENT_USERNAME}:${password}`,
      "utf8",
    ).toString("base64")}`,
    "utf8",
  );
  const received = Buffer.from(authorization, "utf8");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}
