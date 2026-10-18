import Fastify from "fastify";
import { createLogger } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";
import { errorResponseSchema, handleApiError, sendApiError } from "../http/error-response.js";
import {
  propagateRequestContext,
  registerRequestContext,
  REQUEST_ID_HEADER,
} from "./request-context.js";

describe("request context and correlation ID plugin", () => {
  it("generates a correlation ID when request has no inbound ID and echoes it", async () => {
    const app = Fastify();
    registerRequestContext(app);

    app.get("/ping", async (req, reply) => {
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
    expect(echoedId!.length).toBeGreaterThan(0);

    const body = response.json();
    expect(body.id).toBe(echoedId);
    expect(body.requestId).toBe(echoedId);

    await app.close();
  });

  it("preserves inbound correlation ID rather than replacing it", async () => {
    const app = Fastify();
    registerRequestContext(app);

    app.get("/ping", async (req, reply) => {
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

    const body = response.json();
    expect(body.id).toBe(inboundId);
    expect(body.requestId).toBe(inboundId);

    await app.close();
  });

  it("includes correlation ID in structured log lines and error response body", async () => {
    const logLines: Array<Record<string, unknown>> = [];

    const customStream = {
      write(msg: string) {
        try {
          logLines.push(JSON.parse(msg));
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

    const body = response.json();
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

    app.get("/outbound", async (req, reply) => {
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
});
