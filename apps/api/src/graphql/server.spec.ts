import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerGraphQLServer } from "./server.js";

describe("GraphQL Server Bootstrap (Issue 182 / Roadmap 241)", () => {
  it("responds to a trivial { __typename } query at /graphql", async () => {
    const app = Fastify({ logger: false });
    await registerGraphQLServer(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ __typename }" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      data: {
        __typename: "Query",
      },
    });

    await app.close();
  });

  it("responds to { _service } query at /graphql", async () => {
    const app = Fastify({ logger: false });
    await registerGraphQLServer(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ _service }" },
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      data: {
        _service: "verixa-api",
      },
    });

    await app.close();
  });

  it("propagates correlation-id header on GraphQL responses", async () => {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (request, reply) => {
      const id = (request.headers["x-correlation-id"] as string) || "generated-id";
      reply.header("x-correlation-id", id);
    });

    await registerGraphQLServer(app);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ __typename }" },
      headers: {
        "content-type": "application/json",
        "x-correlation-id": "test-correlation-uuid-1234",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe("test-correlation-uuid-1234");

    await app.close();
  });

  it("mounts alongside other routes without conflict", async () => {
    const app = Fastify({ logger: false });
    app.get("/health", async () => ({ status: "ok" }));
    await registerGraphQLServer(app);
    await app.ready();

    const healthRes = await app.inject({
      method: "GET",
      url: "/health",
    });
    expect(healthRes.statusCode).toBe(200);
    expect(healthRes.json()).toEqual({ status: "ok" });

    const gqlRes = await app.inject({
      method: "POST",
      url: "/graphql",
      payload: { query: "{ __typename }" },
      headers: { "content-type": "application/json" },
    });
    expect(gqlRes.statusCode).toBe(200);
    expect(gqlRes.json().data.__typename).toBe("Query");

    await app.close();
  });
});
