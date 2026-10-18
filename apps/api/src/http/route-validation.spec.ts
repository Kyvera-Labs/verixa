import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { assertRouteValidationSchemas } from "./route-validation.js";

describe("route input validation", () => {
  it("rejects malformed input before a route handler runs", async () => {
    const app = Fastify();
    app.addHook("onRoute", (route) => assertRouteValidationSchemas(route));
    const handler = vi.fn(async () => ({ accepted: true }));
    app.post(
      "/widgets",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            additionalProperties: false,
            properties: { name: { type: "string" } },
          },
        },
      },
      handler,
    );

    await app.ready();
    const response = await app.inject({ method: "POST", url: "/widgets", payload: {} });
    expect(response.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails route registration when path parameters have no validator", () => {
    const app = Fastify();
    app.addHook("onRoute", (route) => assertRouteValidationSchemas(route));
    expect(() => app.get("/widgets/:widgetId", async () => ({ ok: true }))).toThrow(
      /missing validation schema\(s\): params/,
    );
  });

  it("fails route registration when a write route has no body validator", () => {
    const app = Fastify();
    app.addHook("onRoute", (route) => assertRouteValidationSchemas(route));
    expect(() => app.post("/widgets", async () => ({ ok: true }))).toThrow(
      /missing validation schema\(s\): body/,
    );
  });
});
