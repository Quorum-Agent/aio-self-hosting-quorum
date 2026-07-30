import type { IncomingMessage, ServerResponse } from "node:http";

import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

import {
  isNetworkDevelopmentAuthorizationValid,
  isOwnDevelopmentOrigin,
  MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH,
} from "./src/lib/development-auth.js";

const DEVELOPMENT_PORT = 5173;
const HMR_PORT = 24678;
const API_TARGET = "http://127.0.0.1:8787";
const REJECTION_DELAY_MS = 250;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// Vite's own defaults, which naming `deny` would otherwise replace.
const DENIED_PATHS = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  // The conversation database lives under the workspace root, so /@fs would
  // otherwise serve it to any authenticated LAN client.
  "**/var/**",
];

function rejectUnauthorized(
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  response.statusCode = 401;
  response.setHeader(
    "WWW-Authenticate",
    'Basic realm="Quorum development", charset="UTF-8"',
  );
  response.setHeader("Cache-Control", "no-store");
  response.end("Authentication is required for Quorum network development.");
}

function networkAuthenticationPlugin(password: string): Plugin {
  return {
    name: "quorum-network-development-authentication",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (
          !isNetworkDevelopmentAuthorizationValid(
            request.headers.authorization,
            password,
          )
        ) {
          // Answer failures slowly. The gate is otherwise a guessing oracle
          // that a LAN client can drive thousands of times per second.
          setTimeout(
            () => rejectUnauthorized(request, response),
            REJECTION_DELAY_MS,
          );
          return;
        }
        next();
      });
    },
  };
}

// Hot reload runs on its own loopback server in network mode, so nothing on
// the public port should be upgrading. Vite leaves an unmatched upgrade socket
// open with no error handler, and a peer that resets one takes the whole
// process down with an unhandled ECONNRESET — a LAN client could stop the
// server at will. Close them deliberately instead. Any future ws:// proxy
// entry has to be excluded here.
function rejectNetworkUpgradesPlugin(): Plugin {
  return {
    name: "quorum-reject-network-upgrades",
    configureServer(server) {
      server.httpServer?.on("upgrade", (_request, socket) => {
        socket.on("error", () => {});
        socket.destroy();
      });
    },
  };
}

// `npm run dev -w @quorum/web -- --host` bypasses scripts/dev.mjs entirely and
// would serve the workspace unauthenticated, so refuse it at the server.
function loopbackOnlyPlugin(): Plugin {
  return {
    name: "quorum-loopback-only",
    configureServer(server) {
      const host = server.config.server.host;
      if (host === undefined || host === false) return;
      if (typeof host === "string" && LOOPBACK_HOSTS.has(host)) return;
      throw new Error(
        "Quorum's default development server is loopback-only. Use `npm run dev:network` for authenticated LAN access.",
      );
    },
  };
}

function networkProxy(): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest, request) => {
        proxyRequest.removeHeader("authorization");
        if (
          !isOwnDevelopmentOrigin(
            request.headers.origin,
            request.headers.host,
          )
        ) {
          return;
        }
        proxyRequest.setHeader("origin", `http://127.0.0.1:${DEVELOPMENT_PORT}`);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const networkMode = mode === "network";
  const password = process.env["QUORUM_DEV_NETWORK_PASSWORD"] ?? "";
  if (
    networkMode &&
    password.length < MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH
  ) {
    throw new Error(
      `QUORUM_DEV_NETWORK_PASSWORD must contain at least ${MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH} characters.`,
    );
  }

  return {
    plugins: [
      ...(networkMode
        ? [networkAuthenticationPlugin(password), rejectNetworkUpgradesPlugin()]
        : [loopbackOnlyPlugin()]),
      react(),
    ],
    server: {
      host: networkMode
        ? (process.env["QUORUM_DEV_NETWORK_HOST"] ?? "0.0.0.0")
        : "127.0.0.1",
      port: DEVELOPMENT_PORT,
      strictPort: true,
      ...(networkMode
        ? {
            // The HMR socket is attached to the raw upgrade event and never
            // reaches the authentication middleware, so keep it off the LAN.
            hmr: { host: "127.0.0.1", port: HMR_PORT },
            // Vite answers preflights before plugin middleware runs, and the
            // app is same-origin through the proxy regardless.
            cors: false,
            fs: { deny: DENIED_PATHS },
          }
        : {}),
      proxy: {
        "/api": networkMode ? networkProxy() : API_TARGET,
      },
    },
  };
});
