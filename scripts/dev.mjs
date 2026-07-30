import { randomBytes } from "node:crypto";

import { concurrently } from "concurrently";

const NETWORK_FLAG = "--network";
const HOST_FLAGS = new Set(["--host", "-H"]);
const argumentsList = process.argv.slice(2);
const networkMode =
  argumentsList.length === 1 && argumentsList[0] === NETWORK_FLAG;

if (
  argumentsList.some(
    (argument) =>
      HOST_FLAGS.has(argument) ||
      argument.startsWith("--host=") ||
      argument.startsWith("-H="),
  )
) {
  console.error(
    [
      "Quorum does not expose its unauthenticated API with Vite's --host flag.",
      "Use `npm run dev:network` with QUORUM_DEV_NETWORK_PASSWORD instead.",
    ].join("\n"),
  );
  process.exit(1);
}

if (argumentsList.length > 0 && !networkMode) {
  console.error(
    `Unknown development option: ${argumentsList.join(" ")}. Use \`npm run dev\` or \`npm run dev:network\`.`,
  );
  process.exit(1);
}

let networkPassword;
if (networkMode) {
  const configuredPassword = process.env["QUORUM_DEV_NETWORK_PASSWORD"];
  if (configuredPassword !== undefined && configuredPassword.length < 16) {
    console.error(
      "When set, QUORUM_DEV_NETWORK_PASSWORD must contain at least 16 characters.",
    );
    process.exit(1);
  }
  networkPassword =
    configuredPassword ?? randomBytes(24).toString("base64url");
  console.log(
    [
      "Starting Quorum's authenticated development gateway.",
      "Sign in when the browser prompts:",
      "  Username: quorum",
      `  Password: ${networkPassword}`,
      configuredPassword === undefined
        ? "This password was generated for this launch only."
        : "This password came from QUORUM_DEV_NETWORK_PASSWORD.",
      "This is plain HTTP for a trusted LAN; use a VPN or encrypted tunnel on untrusted networks.",
    ].join("\n"),
  );
} else {
  console.log(
    "Starting Quorum on loopback only. For authenticated LAN access, use `npm run dev:network`.",
  );
}

const webScript = networkMode ? "dev:network" : "dev";
const { result } = concurrently(
  [
    {
      command: "npm run dev -w @quorum/api",
      name: "api",
      prefixColor: "cyan",
    },
    {
      command: `npm run ${webScript} -w @quorum/web`,
      name: "web",
      prefixColor: "magenta",
      ...(networkPassword
        ? {
            env: {
              ...process.env,
              QUORUM_DEV_NETWORK_PASSWORD: networkPassword,
            },
          }
        : {}),
    },
  ],
  {
    killOthersOn: ["failure"],
    prefix: "name",
  },
);

try {
  await result;
} catch {
  process.exitCode = 1;
}
