/**
 * Tests for the security invariants in `docs/architecture.md` that live in the
 * API layer. Companion to `packages/core/src/security-invariants.test.ts`.
 *
 * REDTEAM-FINDINGS §8 recorded that nobody knew which invariants a test
 * actually enforced. Each test here was written against a mutation — break the
 * invariant in source, run the suite, keep the test only if it turns red.
 *
 * Mutations the pre-existing suite already caught, recorded so the work is not
 * repeated: short-circuiting `normalizeLoopbackBaseUrl` fails 6 tests,
 * short-circuiting `normalizeCloudBaseUrl` fails 6, and forcing a model's
 * `available` flag true in the runtime fails 1.
 */
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { isLoopbackHostname } from "./outbound-url.js";

const TOUCHED = [
  "QUORUM_CLOUD_API_KEY",
  "QUORUM_CLOUD_BASE_URL",
  "QUORUM_CLOUD_MODEL",
  "HOST",
  "QUORUM_DATA_DIR",
] as const;

const original = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of original) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("a cloud provider is absent unless credentials are present", () => {
  // docs/architecture.md: "Cloud providers are absent when credentials are
  // absent." Nothing enforced this: changing the config to register cloud
  // unconditionally left all 136 API tests passing. A cloud model would then
  // appear in the registry, be selectable by the planner, and only fail at
  // request time — or worse, send unauthenticated requests to a real endpoint.
  it("omits cloud entirely when no key is set", () => {
    delete process.env["QUORUM_CLOUD_API_KEY"];
    process.env["QUORUM_CLOUD_BASE_URL"] = "https://api.example.com/v1";

    expect(loadConfig().cloud).toBeUndefined();
  });

  it("omits cloud when the key is present but blank", () => {
    // A key set to whitespace is a misconfiguration, not consent to egress.
    process.env["QUORUM_CLOUD_API_KEY"] = "   ";

    expect(loadConfig().cloud).toBeUndefined();
  });

  it("registers cloud when a key is genuinely present", () => {
    // The negatives above would also pass if cloud support were broken
    // outright, so pin the positive direction.
    process.env["QUORUM_CLOUD_API_KEY"] = "sk-test-key";
    process.env["QUORUM_CLOUD_BASE_URL"] = "https://api.example.com/v1";

    const cloud = loadConfig().cloud;
    expect(cloud).toBeDefined();
    expect(cloud?.apiKey).toBe("sk-test-key");
  });
});

describe("the API binds to loopback only", () => {
  // docs/architecture.md: the loopback HTTP API is not an authorization
  // boundary, which is only true while it stays on loopback.
  it("refuses a non-loopback HOST", () => {
    process.env["HOST"] = "0.0.0.0";

    expect(() => loadConfig()).toThrow(/loopback/iu);
  });

  it("accepts an explicit loopback HOST", () => {
    process.env["HOST"] = "127.0.0.1";

    expect(loadConfig().host).toBe("127.0.0.1");
  });
});

describe("isLoopbackHostname is the shared basis for five separate controls", () => {
  // I-6 (local provider URLs), I-7 (cloud provider URLs), I-13's precondition
  // (the API bind address), the request-time Origin/Host guard in server.ts,
  // and the SSRF check on web-search result URLs all resolve to this one
  // function. It had no dedicated test: each caller tested its own behaviour
  // with one or two hostnames, so the function's edges were covered only by
  // whatever those callers happened to pass.
  //
  // The risk is asymmetric. A false negative rejects a valid loopback address
  // and something visibly breaks. A false positive accepts a non-loopback
  // address as local, and five controls open at once, silently.
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "localhost.",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
  ])("accepts %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "8.8.8.8",
    "::ffff:8.8.8.8",
    "2130706433", // 127.0.0.1 as a decimal integer
    "0x7f000001", // and as hex
    "127.0.0.1.evil.com",
    "notlocalhost",
    "localhost.evil.com",
    "evil.com#localhost",
    "127.0.0.1@evil.com",
    "::2",
    "fe80::1",
    "10.0.0.1",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata, the classic SSRF target
    "",
  ])("rejects %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
});
