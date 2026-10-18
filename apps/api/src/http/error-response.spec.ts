import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from "@verixa/shared-kernel";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { API_ERROR_CODES } from "./error-code-registry.js";
import { errorResponseSchema, handleApiError } from "./error-response.js";

describe("API error contract", () => {
  const apps: FastifyInstance[] = [];
  const makeApp = (): FastifyInstance => {
    const app = Fastify({ logger: false });
    app.setErrorHandler(handleApiError);
    apps.push(app);
    return app;
  };

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const domainFailures: Array<{ path: string; error: Error; status: number; code: string }> = [
    {
      path: "/not-found",
      error: new NotFoundError("User does not exist."),
      status: 404,
      code: "NOT_FOUND",
    },
    {
      path: "/conflict",
      error: new ConflictError("A record already exists."),
      status: 409,
      code: "CONFLICT",
    },
    {
      path: "/forbidden",
      error: new AuthorizationError("Permission denied."),
      status: 403,
      code: "AUTHORIZATION_FAILED",
    },
    {
      path: "/unauthorized",
      error: new AuthenticationError(),
      status: 401,
      code: "AUTHENTICATION_FAILED",
    },
  ];

  it.each(domainFailures)(
    "maps $path into the documented contract",
    async ({ path, error, status, code }) => {
      const app = makeApp();
      app.get(path, () => {
        throw error;
      });

      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(status);
      const body = response.json<{ error: { code: string; message: string; requestId: string } }>();
      expect(body.error.code).toBe(code);
      expect(body.error.message).toBe(error.message);
      expect(typeof body.error.requestId).toBe("string");
    },
  );

  it("includes field details for Fastify schema validation before the handler runs", async () => {
    const app = makeApp();
    let handlerCalled = false;
    app.get(
      "/validated",
      {
        schema: {
          querystring: {
            type: "object",
            required: ["limit"],
            properties: { limit: { type: "integer" } },
          },
        },
      },
      () => {
        handlerCalled = true;
        return { ok: true };
      },
    );

    const response = await app.inject({ method: "GET", url: "/validated" });
    const body = response.json<{
      error: { code: string; requestId: string; details?: { fields?: Record<string, string[]> } };
    }>();
    expect(response.statusCode).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.requestId).toBeTruthy();
    expect(body.error.details?.fields).toBeDefined();
    expect(handlerCalled).toBe(false);
  });

  it("sanitizes uncaught exceptions and keeps their detail out of the response", async () => {
    const app = makeApp();
    app.get("/unexpected", () => {
      throw new Error("database password must not be returned");
    });

    const response = await app.inject({ method: "GET", url: "/unexpected" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("database password");
    const body = response.json<{ error: { code: string; requestId: string } }>();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("publishes the stable code registry through a reusable response schema", () => {
    expect(errorResponseSchema.$id).toBe("ErrorResponse");
    expect(errorResponseSchema.properties.error.properties.code.enum).toEqual(
      Object.keys(API_ERROR_CODES),
    );
    expect(errorResponseSchema.properties.error.required).toContain("requestId");
  });
});
