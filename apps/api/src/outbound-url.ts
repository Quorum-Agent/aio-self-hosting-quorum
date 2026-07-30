import { isIP } from "node:net";

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/g, "");
  const ipVersion = isIP(normalized);
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    (ipVersion === 4 && normalized.startsWith("127.")) ||
    (ipVersion === 6 &&
      (normalized === "::1" || normalized.startsWith("::ffff:127.")))
  );
}

export function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/g, "");
  const ipVersion = isIP(normalized);
  if (
    (ipVersion === 0 && !normalized.includes(".")) ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".example")
  ) {
    return true;
  }
  if (/^127(?:\.\d{1,3}){0,3}$/u.test(normalized)) return true;
  if (
    ipVersion === 0 &&
    (normalized === "localtest.me" ||
      normalized.endsWith(".localtest.me") ||
      normalized === "nip.io" ||
      normalized.endsWith(".nip.io") ||
      normalized === "sslip.io" ||
      normalized.endsWith(".sslip.io"))
  ) {
    return true;
  }
  if (ipVersion === 0) {
    const labels = normalized.split(".");
    for (let index = 0; index <= labels.length - 4; index += 1) {
      const candidate = labels.slice(index, index + 4);
      if (
        candidate.every(
          (label) =>
            /^\d{1,3}$/u.test(label) &&
            Number(label) >= 0 &&
            Number(label) <= 255,
        ) &&
        isPrivateHostname(candidate.join("."))
      ) {
        return true;
      }
    }
  }
  if (ipVersion === 4) {
    const octets = normalized.split(".").map(Number);
    const [first = 0, second = 0] = octets;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19)) ||
      (first === 198 && second === 51 && octets[2] === 100) ||
      (first === 203 && second === 0 && octets[2] === 113) ||
      first >= 224
    );
  }
  if (ipVersion === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("::ffff:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("fec") ||
      normalized.startsWith("fed") ||
      normalized.startsWith("fee") ||
      normalized.startsWith("fef") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("2001:db8:")
    );
  }
  return false;
}

export function normalizeSearchBaseUrl(
  value: string,
  label: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} cannot contain embedded credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} cannot contain a query string or fragment.`);
  }
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback) {
    throw new Error(`${label} must use an explicit loopback hostname.`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback)
  ) {
    throw new Error(
      `${label} must use HTTPS, except for an explicit loopback address.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}
