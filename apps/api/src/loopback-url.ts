function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
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

export function normalizeCloudBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("QUORUM_CLOUD_BASE_URL must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") {
    throw new Error("QUORUM_CLOUD_BASE_URL must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("QUORUM_CLOUD_BASE_URL must not contain credentials.");
  }
  if (url.hash) {
    throw new Error("QUORUM_CLOUD_BASE_URL must not contain a fragment.");
  }
  return url.toString().replace(/\/$/, "");
}
