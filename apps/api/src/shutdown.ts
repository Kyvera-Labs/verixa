/**
 * Maximum time (in milliseconds) allowed for in-flight requests to complete and
 * database / queue resources to drain before forcing process termination.
 * Defaults to 10 seconds, aligning with Docker and Kubernetes default SIGTERM grace periods.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  readonly timeoutMs?: number;
  readonly exitFn?: (code: number) => void;
}

/**
 * Creates an idempotent graceful shutdown handler for SIGTERM and SIGINT:
 *
 * 1. Start a fallback timer that forces exit if draining hangs.
 * 2. `app.close()`: stop accepting connections and wait for in-flight requests.
 * 3. `container.dispose()`: flush batched audit writes and close database pools.
 * 4. Exit with code 0.
 */
export function createShutdownHandler(
  app: {
    readonly log: {
      info: (obj: object, msg?: string) => void;
      error: (obj: object, msg?: string) => void;
    };
    readonly close: () => Promise<void>;
  },
  container: { readonly dispose: () => Promise<void> },
  options: ShutdownOptions = {},
): (signal: string) => Promise<void> {
  let isShuttingDown = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exitFn =
    options.exitFn ??
    ((code?: number): void => {
      process.exit(code);
    });

  return async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      app.log.info({ signal }, "Shutdown already in progress, ignoring duplicate signal");
      return;
    }
    isShuttingDown = true;
    app.log.info({ signal, timeoutMs }, "Received signal, initiating graceful shutdown");

    const forceTimer = setTimeout(() => {
      app.log.error(
        { signal, timeoutMs },
        "Graceful shutdown timed out before connections drained; forcing exit",
      );
      exitFn(1);
    }, timeoutMs);
    forceTimer.unref();

    try {
      // 1. Drain HTTP server: stops accepting new connections, allows in-flight requests to finish
      await app.close();

      // 2. Drain storage/infrastructure: flushes pending audit writes and closes DB connections
      await container.dispose();

      clearTimeout(forceTimer);
      app.log.info({ signal }, "Graceful shutdown complete, exiting cleanly");
      exitFn(0);
    } catch (error) {
      clearTimeout(forceTimer);
      app.log.error({ err: error, signal }, "Error occurred during graceful shutdown");
      exitFn(1);
    }
  };
}
