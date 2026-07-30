import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";

import { loadConfig, PROJECT_ROOT } from "./config.js";
import {
  startManagedLlamaRuntime,
  withManagedLlamaEndpoint,
  type ManagedLlamaRuntime,
} from "./managed-llama-runtime.js";
import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

loadEnvironment({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

let managedLlama: ManagedLlamaRuntime | undefined;
let server: Awaited<ReturnType<typeof buildServer>> | undefined;
let shuttingDown = false;

const shutdown = async (exitCode: number) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server?.close();
  } finally {
    await managedLlama?.stop();
  }
  process.exit(exitCode);
};

try {
  let config = loadConfig();
  if (config.managedLlama) {
    managedLlama = await startManagedLlamaRuntime(
      config.managedLlama,
      config.dataDirectory,
    );
    config = withManagedLlamaEndpoint(config, managedLlama);
  }
  const runtime = await createRuntime(config);
  server = await buildServer(config, runtime);
  const activeServer = server;

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  await activeServer.listen({ host: config.host, port: config.port });
  if (runtime.warmupStatus.state === "warming") {
    activeServer.log.info(
      {
        models: runtime.warmupStatus.models.map((target) => target.model),
      },
      "Warming local Quorum models.",
    );
  }
  void runtime.warmup.then((status) => {
    if (status.state === "degraded") {
      activeServer.log.warn(
        { warmup: status },
        "Local model warmup completed with failures.",
      );
    } else {
      activeServer.log.info(
        { warmup: status },
        "Local model warmup completed.",
      );
    }
  });
} catch (error) {
  if (server) {
    server.log.error(error);
  } else {
    console.error(error);
  }
  await managedLlama?.stop();
  process.exit(1);
}
