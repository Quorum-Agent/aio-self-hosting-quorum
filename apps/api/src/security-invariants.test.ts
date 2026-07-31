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
import { leavesDevice } from "@quorum/core";

import { isLoopbackHostname } from "./outbound-url.js";
import { ConfigurableWebSearchProvider } from "./web-search-provider.js";
import {
  normalizeCloudBaseUrl,
  normalizeNetworkBaseUrl,
} from "./loopback-url.js";

const TOUCHED = [
  "QUORUM_NETWORK_API_KEY",
  "QUORUM_NETWORK_BASE_URL",
  "QUORUM_NETWORK_MODEL",
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

describe("the network tier permits a LAN peer without permitting the internet", () => {
  // Plain HTTP is allowed here and refused by the cloud validator, matching
  // the project's existing stance that unencrypted traffic is acceptable
  // inside a trusted LAN and a tunnel is required outside it. That only holds
  // while the address genuinely is private — otherwise `network` would be a
  // tier with the weakest transport and the widest reach, strictly worse than
  // `cloud`.
  it.each([
    "http://192.168.1.10:8080/v1",
    "http://10.0.0.5:8080/v1",
    "http://172.16.3.9:8080/v1",
    "http://quorum-box.local:8080/v1",
    "https://192.168.1.10:8080/v1",
  ])("accepts the private address %s", (url) => {
    expect(() => normalizeNetworkBaseUrl(url)).not.toThrow();
  });

  it.each([
    "http://8.8.8.8:8080/v1",
    "https://api.openai.com/v1",
    "http://evil.example/v1",
    // Userinfo trick: the host is evil.example, not 192.168.1.10.
    "http://192.168.1.10@evil.example/v1",
  ])("refuses the non-private address %s", (url) => {
    expect(() => normalizeNetworkBaseUrl(url)).toThrow();
  });

  // Integer encodings are NOT rejected, and should not be: `new URL()`
  // resolves them to a dotted quad before the predicate runs, so the check
  // sees — and the request goes to — the address they denote. Pinned because
  // the obvious reading of "decimal-encoded addresses were why isPrivateHostname
  // was too broad" is that they are refused here. They are not; they are
  // normalised, and then judged on where they actually point.
  it.each([
    ["http://3232235777/v1", "192.168.1.1, accepted"],
    ["http://0xC0A80101/v1", "192.168.1.1, accepted"],
  ])("normalises %s before judging it (%s)", (url) => {
    expect(() => normalizeNetworkBaseUrl(url)).not.toThrow();
  });

  it("refuses loopback, which has its own tier rather than being unsafe", () => {
    // Includes the decimal form, which normalises to 127.0.0.1.
    for (const url of ["http://127.0.0.1/v1", "http://2130706433/v1"]) {
      expect(() => normalizeNetworkBaseUrl(url)).toThrow(/private network host/u);
    }
  });

  it("refuses embedded credentials and fragments", () => {
    expect(() => normalizeNetworkBaseUrl("http://user:pw@192.168.1.10/v1")).toThrow(
      /credentials/u,
    );
    expect(() => normalizeNetworkBaseUrl("http://192.168.1.10/v1#x")).toThrow(
      /fragment/u,
    );
  });

  it("still refuses plain HTTP for anything off the network", () => {
    // remote and cloud share the HTTPS-only validator: a rented box on the
    // public internet needs the same transport guarantee a vendor does.
    expect(() => normalizeCloudBaseUrl("http://rented.example/v1")).toThrow(
      /HTTPS/u,
    );
  });
});

describe("a network peer is absent unless credentials are present", () => {
  // Same rule as cloud, for the same reason and then one more. A peer that
  // answers unauthenticated is a peer anyone on the LAN can impersonate —
  // stand up a listener on the expected port and receive the conversation.
  // There is deliberately no anonymous mode.
  it("omits the peer when no key is set", () => {
    delete process.env["QUORUM_NETWORK_API_KEY"];
    process.env["QUORUM_NETWORK_BASE_URL"] = "http://192.168.1.10:8080/v1";

    expect(loadConfig().network).toBeUndefined();
  });

  it("omits the peer when a key is set but no address is", () => {
    process.env["QUORUM_NETWORK_API_KEY"] = "peer-key";
    delete process.env["QUORUM_NETWORK_BASE_URL"];

    expect(loadConfig().network).toBeUndefined();
  });

  it("refuses a peer address that is not on a private network", () => {
    process.env["QUORUM_NETWORK_API_KEY"] = "peer-key";
    process.env["QUORUM_NETWORK_MODEL"] = "peer-model";
    process.env["QUORUM_NETWORK_BASE_URL"] = "https://api.openai.com/v1";

    expect(() => loadConfig()).toThrow(/private network host/u);
  });

  // A model name is required rather than defaulted. Cloud can default to a
  // vendor's catalogue name; a peer serves whatever that machine serves, so
  // guessing is meaningless. Without this the provider registered with an
  // empty id and a blank label, was planner-selectable, and failed only at
  // request time.
  it("omits the peer when no model name is given", () => {
    process.env["QUORUM_NETWORK_API_KEY"] = "peer-key";
    process.env["QUORUM_NETWORK_BASE_URL"] = "http://192.168.1.10:8080/v1";
    delete process.env["QUORUM_NETWORK_MODEL"];

    expect(loadConfig().network).toBeUndefined();
  });

  it("registers a peer when all three are genuinely present", () => {
    process.env["QUORUM_NETWORK_API_KEY"] = "peer-key";
    process.env["QUORUM_NETWORK_MODEL"] = "peer-model";
    process.env["QUORUM_NETWORK_BASE_URL"] = "http://192.168.1.10:8080/v1";

    const network = loadConfig().network;
    expect(network?.apiKey).toBe("peer-key");
    expect(network?.model).toBe("peer-model");
  });
});

describe("a tool's declared location and its disclosure agree", () => {
  // The property that was failing when this was written. A SearXNG on loopback
  // reported `location: "local"` (read by enforcement) alongside
  // `contextMayLeaveDevice: true` (read by disclosure) — one fact, two fields,
  // opposite answers. SearXNG is a metasearch proxy, so the query reaches
  // Google regardless of where the instance listens; the disclosure field was
  // the correct one.
  //
  // It mattered because policies.ts suggests tightening private's toolCeiling
  // to "local", which would have admitted that tool on the strength of the
  // wrong field and then proxied the query out.
  it.each([
    ["searxng on loopback", { provider: "searxng" as const, searxngBaseUrl: "http://127.0.0.1:8888" }],
    ["searxng remote", { provider: "searxng" as const, searxngBaseUrl: "https://search.example.com" }],
    ["auto", { provider: "auto" as const }],
  ])("%s", (_name, settings) => {
    const provider = new ConfigurableWebSearchProvider({
      enabled: true,
      ...settings,
    } as never);
    const tool = provider.tool;

    expect(tool.contextMayLeaveDevice).toBe(leavesDevice(tool.location));
  });
});
