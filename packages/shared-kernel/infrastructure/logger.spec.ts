import type { DestinationStream } from "pino";
import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

function captureLogger(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const destination: DestinationStream = {
    write: (msg: string) => {
      lines.push(msg);
    },
  };

  return { logger: createLogger(options, destination), lines };
}

describe("createLogger", () => {
  it("emits structured JSON with a predictable shape", () => {
    const { logger, lines } = captureLogger({ name: "test-service" });

    logger.info("server started");

    expect(lines).toHaveLength(1);
    const entry: unknown = JSON.parse(lines[0] ?? "");

    expect(entry).toMatchObject({
      level: 30, // pino's numeric "info" level
      msg: "server started",
      name: "test-service",
    });
    expect(entry).toHaveProperty("time");
    expect(typeof (entry as { time: unknown }).time).toBe("number");
  });

  it("respects the configured minimum level", () => {
    const { logger, lines } = captureLogger({ level: "warn" });

    logger.info("should be suppressed");
    logger.warn("should appear");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ msg: "should appear" });
  });

  describe("redaction", () => {
    it("redacts a top-level password field", () => {
      const { logger, lines } = captureLogger();

      logger.info({ password: "hunter2" }, "login attempt");

      const raw = lines[0] ?? "";
      expect(raw).not.toContain("hunter2");
      expect(JSON.parse(raw)).toMatchObject({ password: "[REDACTED]" });
    });

    it("redacts nested token and secret fields", () => {
      const { logger, lines } = captureLogger();

      logger.info(
        { session: { token: "abc123" }, credentials: { secret: "topsecret" } },
        "issuing session",
      );

      const raw = lines[0] ?? "";
      expect(raw).not.toContain("abc123");
      expect(raw).not.toContain("topsecret");
      expect(JSON.parse(raw)).toMatchObject({
        session: { token: "[REDACTED]" },
        credentials: { secret: "[REDACTED]" },
      });
    });

    it("redacts the Authorization request header", () => {
      const { logger, lines } = captureLogger();

      logger.info({ req: { headers: { authorization: "Bearer sekret" } } }, "incoming request");

      const raw = lines[0] ?? "";
      expect(raw).not.toContain("sekret");
      expect(JSON.parse(raw)).toMatchObject({
        req: { headers: { authorization: "[REDACTED]" } },
      });
    });

    it("supports additional caller-supplied redact paths", () => {
      const { logger, lines } = captureLogger({ redact: ["customSecretField"] });

      logger.info({ customSecretField: "should-not-leak" }, "custom event");

      const raw = lines[0] ?? "";
      expect(raw).not.toContain("should-not-leak");
    });
  });

  describe("child loggers", () => {
    it("supports request-scoped context via the standard pino child API", () => {
      const { logger, lines } = captureLogger();
      const requestLogger = logger.child({ reqId: "req-1" });

      requestLogger.info("handled request");

      expect(JSON.parse(lines[0] ?? "")).toMatchObject({
        reqId: "req-1",
        msg: "handled request",
      });
    });

    it("child loggers inherit redaction from the parent", () => {
      const { logger, lines } = captureLogger();
      const requestLogger = logger.child({ reqId: "req-2" });

      requestLogger.info({ password: "hunter2" }, "login attempt");

      const raw = lines[0] ?? "";
      expect(raw).not.toContain("hunter2");
      expect(JSON.parse(raw)).toMatchObject({ reqId: "req-2", password: "[REDACTED]" });
    });
  });
});
