import http from "node:http";

import { buildApp } from "@verixa/api/app";
import { createShutdownHandler, DEFAULT_SHUTDOWN_TIMEOUT_MS } from "@verixa/api/shutdown";
import { describe, expect, it, vi } from "vitest";

describe("Graceful Shutdown & Signal Handling (Issue 388)", () => {
  it("exports a sensible default bounded shutdown timeout (10s)", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });

  describe("createShutdownHandler lifecycle", () => {
    it("drains the app, disposes the container, and exits with code 0 on clean completion", async () => {
      const closeOrder: string[] = [];
      const mockLog = {
        info: vi.fn(),
        error: vi.fn(),
      };
      const mockApp = {
        log: mockLog,
        close: vi.fn().mockImplementation(() => {
          closeOrder.push("app.close");
          return Promise.resolve();
        }),
      };
      const mockContainer = {
        dispose: vi.fn().mockImplementation(() => {
          closeOrder.push("container.dispose");
          return Promise.resolve();
        }),
      };
      const exitFn = vi.fn();

      const shutdown = createShutdownHandler(mockApp, mockContainer, {
        timeoutMs: 5000,
        exitFn,
      });

      await shutdown("SIGTERM");

      expect(closeOrder).toEqual(["app.close", "container.dispose"]);
      expect(mockApp.close).toHaveBeenCalledTimes(1);
      expect(mockContainer.dispose).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(0);
      expect(mockLog.error).not.toHaveBeenCalled();
    });

    it("ignores duplicate signals when a shutdown is already in progress", async () => {
      const mockLog = {
        info: vi.fn(),
        error: vi.fn(),
      };
      let resolveClose: () => void = () => {};
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });

      const mockApp = {
        log: mockLog,
        close: vi.fn().mockReturnValue(closePromise),
      };
      const mockContainer = {
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const exitFn = vi.fn();

      const shutdown = createShutdownHandler(mockApp, mockContainer, {
        timeoutMs: 5000,
        exitFn,
      });

      // First signal initiates shutdown
      const p1 = shutdown("SIGTERM");
      // Second signal should be ignored
      const p2 = shutdown("SIGINT");

      resolveClose();
      await Promise.all([p1, p2]);

      expect(mockApp.close).toHaveBeenCalledTimes(1);
      expect(mockContainer.dispose).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledTimes(1);
      expect(exitFn).toHaveBeenCalledWith(0);
      expect(mockLog.info).toHaveBeenCalledWith(
        { signal: "SIGINT" },
        "Shutdown already in progress, ignoring duplicate signal",
      );
    });

    it("forces process exit with code 1 if resources fail to drain before timeout", async () => {
      const mockLog = {
        info: vi.fn(),
        error: vi.fn(),
      };
      // Hanging close promise
      const mockApp = {
        log: mockLog,
        close: vi.fn().mockReturnValue(new Promise(() => {})),
      };
      const mockContainer = {
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const exitFn = vi.fn();

      const shutdown = createShutdownHandler(mockApp, mockContainer, {
        timeoutMs: 50,
        exitFn,
      });

      void shutdown("SIGTERM");

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(exitFn).toHaveBeenCalledWith(1);
      expect(mockLog.error).toHaveBeenCalled();
    });

    it("exits with code 1 if container disposal fails", async () => {
      const mockLog = {
        info: vi.fn(),
        error: vi.fn(),
      };
      const mockApp = {
        log: mockLog,
        close: vi.fn().mockResolvedValue(undefined),
      };
      const mockContainer = {
        dispose: vi.fn().mockRejectedValue(new Error("Database disconnect error")),
      };
      const exitFn = vi.fn();

      const shutdown = createShutdownHandler(mockApp, mockContainer, {
        timeoutMs: 5000,
        exitFn,
      });

      await shutdown("SIGTERM");

      expect(exitFn).toHaveBeenCalledWith(1);
      expect(mockLog.error).toHaveBeenCalled();
    });
  });

  describe("In-flight request draining over real HTTP", () => {
    it("completes in-flight requests when app.close() is called", async () => {
      const app = buildApp({});

      // Register an endpoint that takes 100ms
      app.get("/test-drain", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { status: "drained_cleanly" };
      });

      const address = await app.listen({ port: 0, host: "127.0.0.1" });
      const port = Number(new URL(address).port);

      // Start the request with Connection: close so idle keep-alive does not hold the socket
      let responseBody = "";
      let statusCode = 0;
      const requestCompleted = new Promise<void>((resolve, reject) => {
        const req = http.get(
          {
            hostname: "127.0.0.1",
            port,
            path: "/test-drain",
            agent: false,
            headers: { Connection: "close" },
          },
          (res) => {
            statusCode = res.statusCode ?? 0;
            res.on("data", (chunk) => {
              responseBody += chunk;
            });
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
      });

      // Allow request to reach the server handler
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Initiate close while request is still running
      const closePromise = app.close();

      await Promise.all([requestCompleted, closePromise]);

      expect(statusCode).toBe(200);
      expect(JSON.parse(responseBody)).toEqual({ status: "drained_cleanly" });
    });
  });
});
