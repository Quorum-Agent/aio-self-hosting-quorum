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

if (networkMode) {
  const password = process.env["QUORUM_DEV_NETWORK_PASSWORD"] ?? "";
  if (password.length < 16) {
    console.error(
      "QUORUM_DEV_NETWORK_PASSWORD must contain at least 16 characters before Quorum can be served to the network.",
    );
    process.exit(1);
  }
  console.log(
    [
      "Starting Quorum's authenticated development gateway.",
      "Use username `quorum` and QUORUM_DEV_NETWORK_PASSWORD when the browser prompts.",
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
