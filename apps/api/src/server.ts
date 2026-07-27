import { ConfigError, loadConfig } from "@verixa/config";
import { createLogger } from "@verixa/shared-kernel";

import { buildApp } from "./app.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    // The structured logger (Issue 008) itself depends on config being valid,
    // so a config error can't be routed through it — this is the one place
    // console.error is the right tool.
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

const logger = createLogger({ name: "verixa-api", level: config.LOG_LEVEL });
const app = buildApp(logger);

app.listen({ port: config.PORT, host: config.HOST }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
