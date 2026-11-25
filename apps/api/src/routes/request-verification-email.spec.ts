import Fastify, { type FastifyInstance } from "fastify";
import supertest from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Container } from "../composition-root.js";
import { handleApiError } from "../http/error-response.js";

import { registerAuthRoutes } from "./auth.js";

describe("POST /request-verification-email (Issue 226 / #167)", () => {
  let app: FastifyInstance;
  const requestEmailVerification = vi.fn(async () => {});
  const recordEvent = vi.fn(async () => {});

  beforeAll(async () => {
    app = Fastify();
    app.setErrorHandler(handleApiError);
    const container = {
      credentials: { requestEmailVerification: { execute: requestEmailVerification } },
      audit: { recordEvent: { execute: recordEvent } },
    } as unknown as Container;
    registerAuthRoutes(app, container);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    requestEmailVerification.mockClear();
    recordEvent.mockClear();
  });

  it("asks the credentials context to send the email and records the request", async () => {
    const res = await supertest(app.server)
      .post("/request-verification-email")
      .send({ email: "dana@example.com" });

    expect(res.status).toBe(200);
    expect(requestEmailVerification).toHaveBeenCalledWith({ email: "dana@example.com" });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "user.email_verification_requested" }),
    );
  });

  it("answers the same way whether or not the address is registered", async () => {
    // The use case is a no-op for unknown addresses; the response must not
    // reveal which case applied, or the route becomes an account-enumeration oracle.
    const known = await supertest(app.server)
      .post("/request-verification-email")
      .send({ email: "dana@example.com" });
    requestEmailVerification.mockResolvedValueOnce(undefined);
    const unknown = await supertest(app.server)
      .post("/request-verification-email")
      .send({ email: "nobody@example.com" });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it("forwards only the email, never other fields from the body", async () => {
    // Fastify's validator strips properties the schema does not declare, so a
    // caller cannot smuggle e.g. a userId through to the use case.
    await supertest(app.server)
      .post("/request-verification-email")
      .send({ email: "dana@example.com", userId: "u_1" });

    expect(requestEmailVerification).toHaveBeenCalledWith({ email: "dana@example.com" });
  });
});
