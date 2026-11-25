import { createLogger } from "@verixa/shared-kernel";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { errorResponseSchema, handleApiError, sendApiError } from "../http/error-response.js";

import {
  propagateRequestContext,
  registerRequestContext,
  REQUEST_ID_HEADER,
} from "./request-context.js";

interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

describe("request context and correlation ID plugin", () => {
  it("generates a correlation ID when request has no inbound ID and echoes it", async () => {
    const app = Fastify();
    registerRequestContext(app);

    app.get("/ping", (req) => {
      return { id: req.id, requestId: req.requestId };
    });

    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/ping",
    });

    expect(response.statusCode).toBe(200);
    const echoedId = response.headers[REQUEST_ID_HEADER];
    expect(echoedId).toBeDefined();
    expect(typeof echoedId).toBe("string");
    expect(String(echoedId).length).toBeGreaterThan(0);

    const body = response.json<{ id: string; requestId: string }>();
    expect(body.id).toBe(echoedId);
    expect(body.requestId).toBe(echoedId);

    await app.close();
  });

  it("preserves inbound correlation ID rather than replacing it", async () => {
    const app = Fastify();
    registerRequestContext(app);

    app.get("/ping", (req) => {
      return { id: req.id, requestId: req.requestId };
    });

    await app.ready();

    const inboundId = "custom-client-trace-id-999";
    const response = await app.inject({
      method: "GET",
      url: "/ping",
      headers: {
        "x-request-id": inboundId,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(inboundId);

    const body = response.json<{ id: string; requestId: string }>();
    expect(body.id).toBe(inboundId);
    expect(body.requestId).toBe(inboundId);

    await app.close();
  });

  it("includes correlation ID in structured log lines and error response body", async () => {
    const logLines: Array<Record<string, unknown>> = [];

    const customStream = {
      write(msg: string) {
        try {
          logLines.push(JSON.parse(msg) as Record<string, unknown>);
        } catch {
          // ignore
        }
      },
    };

    const logger = createLogger({ name: "test-correlation" }, customStream);

    const app = Fastify({
      loggerInstance: logger,
    });
    app.setErrorHandler(handleApiError);
    app.addSchema(errorResponseSchema);

    registerRequestContext(app);

    app.get("/trigger-error", async (req, reply) => {
      req.log.info("Handling request with error");
      sendApiError(reply, "CONFLICT", "Something collided");
    });

    await app.ready();

    const testId = "trace-err-12345";
    const response = await app.inject({
      method: "GET",
      url: "/trigger-error",
      headers: {
        "x-request-id": testId,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(testId);

    const body = response.json<ApiErrorBody>();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.requestId).toBe(testId);

    // Verify logs captured the same correlation ID
    const relevantLog = logLines.find((l) => l["msg"] === "Handling request with error");
    expect(relevantLog).toBeDefined();
    expect(relevantLog?.["requestId"]).toBe(testId);

    await app.close();
  });

  it("propagates correlation ID to outbound call headers", async () => {
    const app = Fastify();
    registerRequestContext(app);

    let capturedOutboundHeaders: Record<string, string> = {};

    app.get("/outbound", (req) => {
      capturedOutboundHeaders = propagateRequestContext(req, {
        Authorization: "Bearer token",
      });
      return { ok: true };
    });

    await app.ready();

    const traceId = "outbound-trace-abc";
    await app.inject({
      method: "GET",
      url: "/outbound",
      headers: {
        "x-request-id": traceId,
      },
    });

    expect(capturedOutboundHeaders["Authorization"]).toBe("Bearer token");
    expect(capturedOutboundHeaders[REQUEST_ID_HEADER]).toBe(traceId);

    await app.close();
  });

  it("links correlationId and traceId in logs and echoes traceId on error responses (Issue 355 / #467)", async () => {
    const logLines: Array<Record<string, unknown>> = [];
    const customStream = {
      write(msg: string) {
        try {
          logLines.push(JSON.parse(msg) as Record<string, unknown>);
        } catch {
          // ignore
        }
      },
    };

    const logger = createLogger({ name: "trace-linkage-test" }, customStream);
    const app = Fastify({ loggerInstance: logger });
    app.setErrorHandler(handleApiError);
    app.addSchema(errorResponseSchema);
    registerRequestContext(app);

    app.get("/error-with-trace", async (req, reply) => {
      req.log.info("Processing traced route failure");
      sendApiError(reply, "CONFLICT", "Conflict during traced operation");
    });

    await app.ready();

    const correlationId = "corr-uuid-467";
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    const response = await app.inject({
      method: "GET",
      url: "/error-with-trace",
      headers: {
        "x-request-id": correlationId,
        "x-trace-id": traceId,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.headers[REQUEST_ID_HEADER]).toBe(correlationId);
    expect(response.headers["x-trace-id"]).toBe(traceId);

    const body = response.json<{
      error: { code: string; message: string; requestId: string; traceId?: string };
    }>();

    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.requestId).toBe(correlationId);
    expect(body.error.traceId).toBe(traceId);

    // Verify structured log line contains BOTH correlationId (requestId) and traceId
    const tracedLog = logLines.find((l) => l["msg"] === "Processing traced route failure");
    expect(tracedLog).toBeDefined();
    expect(tracedLog?.["requestId"]).toBe(correlationId);
    expect(tracedLog?.["traceId"]).toBe(traceId);

    await app.close();
  });

  it("extracts trace ID from W3C traceparent header when present", async () => {
    const app = Fastify();
    registerRequestContext(app);

    app.get("/traceparent-check", (req) => {
      return { traceId: req.traceId };
    });

    await app.ready();

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;

    const response = await app.inject({
      method: "GET",
      url: "/traceparent-check",
      headers: {
        traceparent,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-trace-id"]).toBe(traceId);
    const body = response.json<{ traceId: string }>();
    expect(body.traceId).toBe(traceId);

    await app.close();
  });
});
