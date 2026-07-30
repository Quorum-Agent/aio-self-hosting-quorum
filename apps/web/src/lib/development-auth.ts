import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

export const NETWORK_DEVELOPMENT_USERNAME = "quorum";
export const MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH = 8;

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
