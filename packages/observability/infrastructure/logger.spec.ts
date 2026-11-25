import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createContextualLogger } from "./logger.js";
import { runWithRequestContext } from "./request-context.js";

interface LogEntry {
  level?: number;
  msg?: string;
  name?: string;
  correlationId?: string;
  requestId?: string;
  traceId?: string;
  actorId?: string;
  route?: string;
  customEnv?: string;
  password?: string;
  token?: string;
  accessToken?: string;
  authorization?: string;
  req?: {
    id?: string;
    headers?: {
      authorization?: string;
      cookie?: string;
    };
  };
  trace?: {
    id?: string;
  };
  actor?: {
    id?: string;
  };
  "req.id"?: string;
  "trace.id"?: string;
  "actor.id"?: string;
  [key: string]: unknown;
}

function createLogCapture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });

  const getParsedLogs = (): LogEntry[] => {
    return lines
      .join("")
      .trim()
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LogEntry);
  };

  return { stream, getParsedLogs };
}

describe("createContextualLogger", () => {
  it("emits standard structured logs when no request context is present", () => {
    const { stream, getParsedLogs } = createLogCapture();
    const logger = createContextualLogger({ name: "test-service" }, stream);

    logger.info("standalone message outside request");

    const logs = getParsedLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.msg).toBe("standalone message outside request");
    expect(log.name).toBe("test-service");
    expect(log.correlationId).toBeUndefined();
    expect(log.traceId).toBeUndefined();
  });

  it("automatically enriches logs with correlationId and traceId and taxonomy fields during a request", () => {
    const { stream, getParsedLogs } = createLogCapture();
    const logger = createContextualLogger({ name: "api-service" }, stream);

    runWithRequestContext(
      {
        correlationId: "corr-12345",
        traceId: "trace-abcde-67890",
        actorId: "actor-usr-999",
        route: "/api/v1/auth/login",
      },
      () => {
        logger.info("User login attempt");
        logger.warn({ attemptCount: 2 }, "Second failed attempt");
      },
    );

    const logs = getParsedLogs();
    expect(logs).toHaveLength(2);

    for (const log of logs) {
      // Direct fields
      expect(log.correlationId).toBe("corr-12345");
      expect(log.traceId).toBe("trace-abcde-67890");
      expect(log.actorId).toBe("actor-usr-999");
      expect(log.route).toBe("/api/v1/auth/login");

      // Taxonomy fields (req.id, trace.id, actor.id)
      expect(log["req.id"]).toBe("corr-12345");
      expect(log["trace.id"]).toBe("trace-abcde-67890");
      expect(log["actor.id"]).toBe("actor-usr-999");
    }
  });

  it("redacts sensitive fields like passwords, tokens, and authorization headers", () => {
    const { stream, getParsedLogs } = createLogCapture();
    const logger = createContextualLogger({}, stream);

    logger.info({
      password: "super-secret-password",
      token: "secret-token",
      accessToken: "my-jwt-access-token",
      authorization: "Bearer secret-bearer-token",
      req: {
        headers: {
          authorization: "Bearer nested-secret",
          cookie: "session=sensitive-cookie",
        },
      },
    });

    const logs = getParsedLogs();
    expect(logs).toHaveLength(1);
    const logged = logs[0]!;

    expect(logged.password).toBe("[REDACTED]");
    expect(logged.token).toBe("[REDACTED]");
    expect(logged.accessToken).toBe("[REDACTED]");
    expect(logged.authorization).toBe("[REDACTED]");
    expect(logged.req?.headers?.authorization).toBe("[REDACTED]");
    expect(logged.req?.headers?.cookie).toBe("[REDACTED]");
  });

  it("supports custom mixin chaining", () => {
    const { stream, getParsedLogs } = createLogCapture();
    const logger = createContextualLogger(
      {
        mixin: () => ({ customEnv: "staging-1" }),
      },
      stream,
    );

    runWithRequestContext({ correlationId: "corr-mix" }, () => {
      logger.info("Custom mixed message");
    });

    const logs = getParsedLogs();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.correlationId).toBe("corr-mix");
    expect(log.customEnv).toBe("staging-1");
  });
});
