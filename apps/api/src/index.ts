import "dotenv/config";

import { loadConfig } from "./config.js";
import { createRuntime } from "./runtime.js";
import { buildServer } from "./server.js";

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
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
