import type { IncomingMessage, ServerResponse } from "node:http";

import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

import {
  isNetworkDevelopmentAuthorizationValid,
  MINIMUM_NETWORK_DEVELOPMENT_PASSWORD_LENGTH,
} from "./src/lib/development-auth.js";

const DEVELOPMENT_PORT = 5173;
const API_TARGET = "http://127.0.0.1:8787";

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
          rejectUnauthorized(request, response);
          return;
        }
        next();
      });
    },
  };
}

function networkProxy(): ProxyOptions {
  return {
    target: API_TARGET,
    changeOrigin: true,
    configure(proxy) {
      proxy.on("proxyReq", (proxyRequest) => {
        proxyRequest.removeHeader("authorization");
        proxyRequest.setHeader(
          "origin",
          `http://127.0.0.1:${DEVELOPMENT_PORT}`,
        );
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
      ...(networkMode ? [networkAuthenticationPlugin(password)] : []),
      react(),
    ],
    server: {
      host: networkMode
        ? (process.env["QUORUM_DEV_NETWORK_HOST"] ?? "0.0.0.0")
        : "127.0.0.1",
      port: DEVELOPMENT_PORT,
      strictPort: true,
      proxy: {
        "/api": networkMode ? networkProxy() : API_TARGET,
      },
    },
  };
});
