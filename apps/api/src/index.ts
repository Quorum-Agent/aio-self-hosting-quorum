import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";

import { loadConfig, PROJECT_ROOT } from "./config.js";
import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

loadEnvironment({ path: resolve(PROJECT_ROOT, ".env"), quiet: true });

const config = loadConfig();
const runtime = await createRuntime(config);
const server = await buildServer(config, runtime);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await server.listen({ host: config.host, port: config.port });
  if (runtime.warmupStatus.state === "warming") {
    server.log.info(
      {
        models: runtime.warmupStatus.models.map((target) => target.model),
      },
      "Warming local Quorum models.",
    );
  }
  void runtime.warmup.then((status) => {
    if (status.state === "degraded") {
      server.log.warn(
        { warmup: status },
        "Local model warmup completed with failures.",
      );
    } else {
      server.log.info(
        { warmup: status },
        "Local model warmup completed.",
      );
    }
  });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
