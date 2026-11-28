import { buildApp } from "@verixa/api/app";
import type { Container } from "@verixa/api/composition-root";
import supertest from "supertest";

/**
 * Boots an in-process `apps/api` Fastify instance and returns a Supertest agent plus `close()`.
 * Imports `@verixa/api/app`, which only builds the app, not `@verixa/api`, whose `server.ts` loads
 * config and listens on import.
 */
export interface HttpTestClient {
  /** A Supertest agent — call `.get("/path")`, `.post("/path")`, etc. */
  request: ReturnType<typeof supertest>;
  /** Closes the underlying Fastify instance. Always call this, even on failure. */
  close: () => Promise<void>;
}

export async function createHttpTestClient(container?: Container): Promise<HttpTestClient> {
  const app = buildApp(container === undefined ? {} : { container });
  await app.ready();

  return {
    request: supertest(app.server),
    close: () => app.close(),
  };
}
