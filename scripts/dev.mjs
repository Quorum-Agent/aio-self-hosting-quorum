import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";

import { concurrently } from "concurrently";
import { parse as parseEnvironment } from "dotenv";

const NETWORK_FLAG = "--network";
const HOST_FLAGS = new Set(["--host", "-H"]);
// The generated pairing code is short but random. A password a human chooses
// and reuses has to be long enough to survive an unthrottled LAN guesser.
const MINIMUM_CONFIGURED_PASSWORD_LENGTH = 24;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function configuredNetworkPassword() {
  const inherited = process.env["QUORUM_DEV_NETWORK_PASSWORD"];
  if (inherited !== undefined) return inherited;
  try {
    return parseEnvironment(readFileSync(".env"))[
      "QUORUM_DEV_NETWORK_PASSWORD"
    ];
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

function pairingCodePart() {
  let part = "";
  for (let index = 0; index < 4; index += 1) {
    part += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return part;
}

function generatePairingCode() {
  return `${pairingCodePart()}-${pairingCodePart()}`;
}

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
      "Use `npm run dev:network` instead.",
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
  const configuredPassword = configuredNetworkPassword();
  if (
    configuredPassword !== undefined &&
    configuredPassword.length < MINIMUM_CONFIGURED_PASSWORD_LENGTH
  ) {
    console.error(
      [
        `When set, QUORUM_DEV_NETWORK_PASSWORD must contain at least ${MINIMUM_CONFIGURED_PASSWORD_LENGTH} characters.`,
        "Unset it to use a generated per-launch pairing code instead.",
      ].join("\n"),
    );
    process.exit(1);
  }
  networkPassword = configuredPassword ?? generatePairingCode();
  console.log(
    [
      "Starting Quorum's authenticated development gateway.",
      "Sign in when the browser prompts:",
      "  Username: quorum",
      `  Password: ${networkPassword}`,
      configuredPassword === undefined
        ? "This pairing code was generated for this launch only."
        : "This dedicated password came from QUORUM_DEV_NETWORK_PASSWORD.",
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
