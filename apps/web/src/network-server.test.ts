import { afterEach, describe, expect, it } from "vitest";

// Named away from vite.config.* on purpose: vitest's default exclude list
// drops that pattern, so a test file named after the config never runs.
import configureVite from "../vite.config.js";

const PASSWORD_VARIABLE = "QUORUM_DEV_NETWORK_PASSWORD";
const LONG_ENOUGH_PASSWORD = "a-sufficiently-long-development-phrase";
const originalPassword = process.env[PASSWORD_VARIABLE];

function resolve(mode: string) {
  const configured = configureVite({ command: "serve", mode });
  if (typeof configured === "function" || "then" in configured) {
    throw new Error("Expected a synchronous configuration object.");
  }
  return configured;
}

describe("network development server", () => {
  afterEach(() => {
    if (originalPassword === undefined) delete process.env[PASSWORD_VARIABLE];
    else process.env[PASSWORD_VARIABLE] = originalPassword;
  });

  it("keeps the hot-reload socket off the network", () => {
    process.env[PASSWORD_VARIABLE] = LONG_ENOUGH_PASSWORD;
    // The socket attaches to the raw upgrade event and never passes through
    // the authentication middleware, so it must not listen on the LAN.
    expect(resolve("network").server?.hmr).toMatchObject({ host: "127.0.0.1" });
  });

  it("does not answer cross-origin preflights ahead of authentication", () => {
    process.env[PASSWORD_VARIABLE] = LONG_ENOUGH_PASSWORD;
    expect(resolve("network").server?.cors).toBe(false);
  });

  it("refuses to serve the conversation database or secrets over /@fs", () => {
    process.env[PASSWORD_VARIABLE] = LONG_ENOUGH_PASSWORD;
    const deny = resolve("network").server?.fs?.deny ?? [];
    expect(deny).toContain("**/var/**");
    // Naming deny replaces Vite's defaults, so they must be restated.
    expect(deny).toContain(".env");
    expect(deny).toContain("**/.git/**");
  });

  it("closes upgrade sockets that nothing on the public port owns", () => {
    process.env[PASSWORD_VARIABLE] = LONG_ENOUGH_PASSWORD;
    // Hot reload moved to its own loopback server, leaving upgrade sockets on
    // this port unowned. Vite attaches no error handler to them, so a peer
    // that resets one killed the process — a LAN client could stop the server.
    const plugins = resolve("network").plugins?.flat() ?? [];
    expect(
      plugins.some(
        (plugin) =>
          plugin &&
          typeof plugin === "object" &&
          "name" in plugin &&
          plugin.name === "quorum-reject-network-upgrades",
      ),
    ).toBe(true);
  });

  it("refuses to start network mode without a usable password", () => {
    process.env[PASSWORD_VARIABLE] = "short";
    expect(() => resolve("network")).toThrow(/at least/);
  });

  it("binds to loopback and adds no network exposure by default", () => {
    delete process.env[PASSWORD_VARIABLE];
    const server = resolve("development").server;
    expect(server?.host).toBe("127.0.0.1");
    expect(server?.hmr).toBeUndefined();
    expect(server?.cors).toBeUndefined();
  });
});
