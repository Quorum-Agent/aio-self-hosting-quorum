import { describe, expect, it } from "vitest";

import {
  normalizeCloudBaseUrl,
  normalizeLoopbackBaseUrl,
} from "./loopback-url.js";

describe("normalizeLoopbackBaseUrl", () => {
  it.each([
    "http://127.0.0.1:11434/v1",
    "http://127.42.0.9:11434/v1/",
    "http://127.1:11434/v1",
    "http://localhost:11434/v1",
    "http://[::1]:11434/v1",
  ])("accepts an explicit loopback endpoint: %s", (value) => {
    expect(normalizeLoopbackBaseUrl(value)).toMatch(/^http/);
  });

  it.each([
    "https://example.com/v1",
    "http://192.168.1.10:11434/v1",
    "http://ollama.internal:11434/v1",
    "file:///tmp/models",
    "not a url",
  ])("rejects a non-loopback local endpoint: %s", (value) => {
    expect(() => normalizeLoopbackBaseUrl(value)).toThrow(
      /QUORUM_LOCAL_BASE_URL/,
    );
  });
});

describe("normalizeCloudBaseUrl", () => {
  it("accepts an HTTPS cloud endpoint", () => {
    expect(normalizeCloudBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });

  it.each([
    "http://api.example.com/v1",
    "https://user:secret@api.example.com/v1",
    "https://api.example.com/v1#fragment",
  ])("rejects an unsafe cloud endpoint: %s", (value) => {
    expect(() => normalizeCloudBaseUrl(value)).toThrow(
      /QUORUM_CLOUD_BASE_URL/,
    );
  });
});
