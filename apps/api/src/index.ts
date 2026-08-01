import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";

import { loadConfig, PROJECT_ROOT } from "./config.js";
import {
  managedLlamaProblem,
  startManagedLlamaOrDegrade,
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
  let managedLlamaFailure: { message: string; error: unknown } | undefined;
  ({ config, runtime: managedLlama } = await startManagedLlamaOrDegrade(
    config,
    (message, error) => {
      managedLlamaFailure = { message, error };
      console.error(message, error);
    },
  ));
  // The cause travels with the status, not only to the log. `llama-server`
  // exits on a rejected artifact and the readiness loop keeps its last output,
  // so by this point the exact reason is in hand — "error loading model
  // hyperparameters: key qwen35.rope.dimension_sections has wrong array length"
  // for a model this build cannot load. Printing that to a console the operator
  // is not watching, while the interface says only "unavailable", is how a
  // five-item checklist gets offered for a problem already diagnosed.
  const runtime = await createRuntime(config, {
    ...(managedLlamaFailure
      ? { problem: managedLlamaProblem(managedLlamaFailure.error) }
      : {}),
  });
  server = await buildServer(config, runtime);
  const activeServer = server;

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));
  await activeServer.listen({ host: config.host, port: config.port });
  if (managedLlamaFailure) {
    // Repeat it through the real logger now one exists, so the reason is in the
    // same place as every other operational event rather than only on stderr
    // before startup.
    activeServer.log.error(
      { err: managedLlamaFailure.error },
      managedLlamaFailure.message,
    );
  }
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
