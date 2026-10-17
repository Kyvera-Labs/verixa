import { ConfigError, loadConfig } from "@verixa/config";
import { createLogger } from "@verixa/shared-kernel";

import { buildApp } from "./app.js";
import { buildContainer } from "./composition-root.js";
import { securityHeadersFromConfig } from "./plugins/security-headers.js";

let config;
let securityHeaders;
try {
  config = loadConfig();
  // Derived beside config loading, not inside `buildApp`, because an
  // impossible pairing of the transport-security variables (Issue 213) is a
  // configuration error and belongs on this same fail-fast path — printed to
  // stderr, not routed through a logger that does not exist yet.
  securityHeaders = securityHeadersFromConfig(config);
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

// The composition root, finally constructed at runtime rather than only in
// tests. Until this line existed, every repository, use case and mapper in
// the workspace was unreachable from a running server.
const container = buildContainer();
const app = buildApp({
  logger,
  container,
  securityHeaders,
  trustProxy: config.TRUST_PROXY,
});

// Close the database connection on shutdown rather than letting the process
// exit with connections still checked out. Postgres reclaims them eventually,
// but "eventually" during a rolling deploy means the new instances compete
// for a pool the old ones have not released.
const shutdown = (signal: string): void => {
  app.log.info({ signal }, "shutting down");
  void app
    .close()
    .then(() => container.dispose())
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    });
};

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  shutdown("SIGINT");
});

app.listen({ port: config.PORT, host: config.HOST }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
