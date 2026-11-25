import type { Container } from "@verixa/api/composition-root";
import { AuthenticationError, Result } from "@verixa/shared-kernel";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpTestClient, type HttpTestClient } from "./helpers/http-client.js";

/**
 * Snapshot of the shared error envelope (Issue 418), taken over real HTTP.
 *
 * The convention this file is the worked example of lives in
 * `docs/guides/testing/snapshot-testing.md`. In short: the *shape* of the
 * envelope is snapshotted, because an accidental rename or restructure is
 * exactly the drift a snapshot catches for free; the values a client branches
 * on (status, `error.code`) are asserted explicitly, because a snapshot diff
 * is far too easy to accept for a change that matters.
 *
 * Every case goes through `buildApp` and `handleApiError`/`sendApiError` — the
 * real error contract — rather than a hand-built Fastify instance, so the
 * snapshot describes what clients actually receive.
 *
 * No database is needed. Where a case has to reach a use case, the container
 * is a partial stub (the same approach as `graphql-identity.spec.ts`): the
 * envelope is produced by the HTTP layer, and the use case only has to fail
 * the right way.
 */

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/**
 * `requestId` is generated per request and differs between runs and between
 * test orderings, so it is matched by type rather than value. It is the only
 * volatile field in the envelope; anything added later that varies per
 * request (a timestamp, a trace id) gets a matcher here too, never a
 * hard-coded value in the `.snap` file.
 */
const volatileFields: { error: { requestId: unknown } } = {
  error: { requestId: expect.any(String) },
};

/** A message that must never reach a client: the kind an infrastructure failure carries. */
const LEAKY_INTERNAL_MESSAGE =
  'connect ECONNREFUSED: postgres://verixa:secret@db.internal:5432 relation "users"';

/**
 * A container that wires only what `POST /auth/login` touches.
 *
 * `login` decides how the use case fails; the audit recorder accepts anything,
 * because a failed login is audited before the error response is sent.
 */
function loginContainer(login: () => Promise<unknown>): Container {
  return {
    credentials: { authenticateWithPassword: { execute: login } },
    audit: { recordEvent: { execute: () => Promise.resolve(Result.ok(undefined)) } },
  } as unknown as Container;
}

const unusedContainer = loginContainer(() => {
  throw new Error("the use case must not run for this request");
});

describe("shared error envelope", () => {
  let client: HttpTestClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("400 VALIDATION_ERROR: a request rejected by route schema validation", async () => {
    client = await createHttpTestClient(unusedContainer);

    const response = await client.request.post("/auth/login").send({ email: "a@example.com" });

    expect(response.status).toBe(400);
    const body = response.body as ErrorEnvelope;
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body).toMatchSnapshot(volatileFields);
  });

  it("401 AUTHENTICATION_FAILED: a domain error returned by a use case", async () => {
    client = await createHttpTestClient(
      loginContainer(() => Promise.resolve(Result.err(new AuthenticationError()))),
    );

    const response = await client.request
      .post("/auth/login")
      .send({ email: "a@example.com", password: "wrong-password" });

    expect(response.status).toBe(401);
    const body = response.body as ErrorEnvelope;
    expect(body.error.code).toBe("AUTHENTICATION_FAILED");
    expect(body).toMatchSnapshot(volatileFields);
  });

  it("403 FORBIDDEN: a request refused by a route guard", async () => {
    client = await createHttpTestClient(unusedContainer);

    const response = await client.request.get("/verification/review-queue");

    expect(response.status).toBe(403);
    const body = response.body as ErrorEnvelope;
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body).toMatchSnapshot(volatileFields);
  });

  it("500 INTERNAL_ERROR: an unexpected failure, with its detail withheld", async () => {
    client = await createHttpTestClient(
      loginContainer(() => Promise.reject(new Error(LEAKY_INTERNAL_MESSAGE))),
    );

    const response = await client.request
      .post("/auth/login")
      .send({ email: "a@example.com", password: "any-password" });

    expect(response.status).toBe(500);
    const body = response.body as ErrorEnvelope;
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // Asserted explicitly as well as snapshotted: withholding the cause is a
    // security property, and a reviewer skimming a snapshot diff must not be
    // the only thing standing between a connection string and a client.
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(body).toMatchSnapshot(volatileFields);
  });

  // No 404 case: an unknown route is answered by Fastify's default not-found
  // handler, which does not use this envelope. That gap is tracked as a
  // follow-up rather than snapshotted here — a snapshot of the wrong shape
  // would make the gap look like the contract.
});
