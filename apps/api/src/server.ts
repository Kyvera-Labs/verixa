import { ConfigError, loadConfig } from "@verixa/config";
import { createLogger } from "@verixa/shared-kernel";

import { buildApp } from "./app.js";
import { buildContainer } from "./composition-root.js";
import { corsPolicyFromConfig } from "./plugins/cors.js";
import { securityHeadersFromConfig } from "./plugins/security-headers.js";
import { createShutdownHandler } from "./shutdown.js";

let config;
let securityHeaders;
let corsPolicy;
try {
  config = loadConfig();
  // Derived beside config loading, not inside `buildApp`, because an
  // impossible pairing of the transport-security variables (Issue 213) is a
  // configuration error and belongs on this same fail-fast path — printed to
  // stderr, not routed through a logger that does not exist yet.
  securityHeaders = securityHeadersFromConfig(config);
  // Derived on the same fail-fast path as the transport policy (and for the
  // same reason): a wildcard origin combined with credentialed requests is a
  // configuration error, not something to discover from a browser console.
  // `loadConfig` already rejects it, so this is the second, cheaper guarantee
  // that a direct `CorsPolicy` built somewhere else cannot slip past.
  corsPolicy = corsPolicyFromConfig(config);
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

// The composition root, finally constructed at runtime rather than only in
// tests. Until this line existed, every repository, use case and mapper in
// the workspace was unreachable from a running server.
const container = buildContainer();
const logger =
  container.observability?.logger ?? createLogger({ name: "verixa-api", level: config.LOG_LEVEL });

const app = buildApp({
  logger,
  container,
  metricsRecorder: container.observability?.metricsRecorder,
  healthCheckRegistry: container.observability?.healthCheckRegistry,
  metricsEndpoint: config.METRICS_ENABLED,
  securityHeaders,
  cors: corsPolicy,
  trustProxy: config.TRUST_PROXY,
});

export {
  createShutdownHandler,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  type ShutdownOptions,
} from "./shutdown.js";

const shutdown = createShutdownHandler(app, container);

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

app.listen({ port: config.PORT, host: config.HOST }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
