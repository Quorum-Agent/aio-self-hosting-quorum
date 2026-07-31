import { isIP } from "node:net";

import { isLoopbackHostname } from "./outbound-url.js";

/**
 * Whether a hostname names a host on the operator's own network.
 *
 * Purpose-built rather than reusing `isPrivateHostname`. That function is an
 * SSRF *rejection* list and is deliberately over-broad — it also matches
 * documentation and reserved TLDs like `.example`, `.test` and `.invalid`, and
 * decimal-encoded integer addresses. Broad is the right shape for "refuse to
 * fetch this"; inverted into "accept this as a peer" it lets
 * `http://evil.example/v1` through. An acceptance predicate has to enumerate
 * what is allowed, not negate what is denied.
 *
 * CGNAT (100.64/10) is included deliberately: it is the range Tailscale and
 * similar tunnels assign, which is the recommended way to reach a peer that
 * is not physically on the LAN.
 */
function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
  const version = isIP(host);

  if (version === 4) {
    const octets = host.split(".").map(Number);
    const [a = 0, b = 0] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (version === 6) {
    // Unique-local fc00::/7 and link-local fe80::/10.
    return /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host);
  }
  // Names, not addresses. Only mDNS and the conventional private suffixes —
  // notably NOT .example/.test/.invalid, which are reserved for documentation
  // and would otherwise be accepted as peers.
  return [".local", ".lan", ".internal", ".home", ".home.arpa"].some((suffix) =>
    host.endsWith(suffix),
  );
}

export function normalizeLoopbackBaseUrl(
  value: string,
  setting = "QUORUM_LOCAL_BASE_URL",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${setting} must be a valid absolute URL.`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${setting} must use HTTP or HTTPS.`);
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      `${setting} must resolve explicitly to localhost, 127.0.0.0/8, or ::1.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(`${setting} must not contain credentials.`);
  }

  return url.toString().replace(/\/$/, "");
}

/**
 * A peer on the operator's own network: reachable, but not off it.
 *
 * Plain HTTP is permitted, which `normalizeCloudBaseUrl` would refuse. That is
 * deliberate and matches the project's existing stance — the development
 * gateway documents plain HTTP as acceptable inside a trusted LAN with a
 * tunnel required outside it, and requiring TLS here would mean self-signed
 * certificates on every home network.
 *
 * The address must therefore actually BE private. Without that check,
 * `network` would be a tier permitting unencrypted egress to anywhere, which
 * is strictly worse than `cloud` — the weakest transport with the widest
 * reach. `isPrivateHostname` already classifies RFC1918, link-local, ULA and
 * the `.local`/`.lan`/`.internal` suffixes; it exists as an SSRF rejection
 * list and is used here as an acceptance predicate, which is the same
 * classification read in the opposite direction.
 */
export function normalizeNetworkBaseUrl(
  value: string,
  setting = "QUORUM_NETWORK_BASE_URL",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${setting} must be a valid absolute URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${setting} must use HTTP or HTTPS.`);
  }
  if (!isPrivateNetworkHost(url.hostname)) {
    throw new Error(
      `${setting} must address a private network host; a public address is not a network peer.`,
    );
  }
  if (url.username || url.password) {
    throw new Error(`${setting} must not contain credentials.`);
  }
  if (url.hash) {
    throw new Error(`${setting} must not contain a fragment.`);
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * A host outside the operator's network — a rented box or a vendor API.
 *
 * Both tiers use this. A self-hosted llama.cpp on the public internet needs
 * exactly the same transport guarantee as a vendor does; only the trust in
 * who runs the stack differs, and that is a policy question rather than a URL
 * one.
 */
export function normalizeCloudBaseUrl(
  value: string,
  setting = "QUORUM_CLOUD_BASE_URL",
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${setting} must be a valid absolute URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${setting} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new Error(`${setting} must not contain credentials.`);
  }
  if (url.hash) {
    throw new Error(`${setting} must not contain a fragment.`);
  }
  return url.toString().replace(/\/$/, "");
}
