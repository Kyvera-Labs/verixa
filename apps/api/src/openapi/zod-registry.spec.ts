import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  enforceRegisteredRouteSchemas,
  getOpenApiComponents,
  registerZodSchema,
} from "./zod-registry.js";

describe("Zod OpenAPI schema registry", () => {
  it("uses one schema for Fastify validation and the OpenAPI component", async () => {
    const app = Fastify();
    const payload = z.object({ name: z.string().min(3) }).strict();
    const body = registerZodSchema(app, "CreateWidgetBody", payload);
    const handler = vi.fn((_request, reply) => reply.send({ ok: true }));
    app.post("/widgets", { schema: { body } }, handler);

    await app.ready();
    const invalid = await app.inject({ method: "POST", url: "/widgets", payload: { name: "x" } });
    expect(invalid.statusCode).toBe(400);
    expect(handler).not.toHaveBeenCalled();

    const components = getOpenApiComponents(app);
    expect(components.schemas.CreateWidgetBody).toMatchObject({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string", minLength: 3 } },
      additionalProperties: false,
    });
    expect(app.getSchema("CreateWidgetBody")).toEqual(components.schemas.CreateWidgetBody);
    await app.close();
  });

  it("fails route registration when an input schema is not a registered component", async () => {
    const app = Fastify();
    enforceRegisteredRouteSchemas(app);
    expect(() =>
      app.post("/widgets", { schema: { body: { type: "object" } } }, async () => ({ ok: true })),
    ).toThrow(/must use a registered Zod schema/);
    await app.close();
  });
});
