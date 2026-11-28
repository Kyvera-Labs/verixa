import { buildContainer, type Container } from "@verixa/api/composition-root";
import { PasswordResetToken } from "@verixa/credentials";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createTestPrismaClient,
  databaseAvailability,
} from "../../integration/helpers/database.js";
import {
  createHttpTestClient,
  type HttpTestClient,
} from "../../integration/helpers/http-client.js";
import { resetDatabase } from "../harness/reset-database.js";

const available = await databaseAvailability();

interface LoginResponse {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

interface ForgotPasswordResponse {
  readonly message: string;
}

interface ResetPasswordResponse {
  readonly status: string;
  readonly user: {
    readonly id: string;
    readonly email: string;
  };
}

describe.skipIf(!available)("E2E Journey: Login -> Forgot Password -> Reset -> Login", () => {
  const prisma = createTestPrismaClient();
  let container: Container;
  let client: HttpTestClient;

  beforeAll(async () => {
    await prisma.$connect();
    container = buildContainer(prisma);
    client = await createHttpTestClient(container);
  }, 60_000);

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await client?.close();
    await resetDatabase(prisma);
    await prisma.$disconnect();
  }, 60_000);

  it("successfully resets credentials and verifies old password rejection", async () => {
    const userEmail = "peter.parker@example.com";
    const initialPassword = "Old-Password-123456#";
    const newPassword = "Brand-New-Password-789012$";

    // Register initial user
    const registerRes = await client.request.post("/auth/register").send({
      email: userEmail,
      displayName: "Peter Parker",
      password: initialPassword,
    });
    expect(registerRes.status).toBe(201);
    const userId = (registerRes.body as { id: string }).id;

    // Login requires an active user.
    await prisma.user.update({
      where: { id: userId },
      data: { status: "active" },
    });

    // -------------------------------------------------------------------------
    // Step 1: Initial Login with original password
    // -------------------------------------------------------------------------
    const firstLoginRes = await client.request.post("/auth/login").send({
      email: userEmail,
      password: initialPassword,
    });

    expect(firstLoginRes.status).toBe(200);
    const firstLoginBody = firstLoginRes.body as LoginResponse;
    expect(firstLoginBody.id).toBe(userId);
    expect(firstLoginBody.email).toBe(userEmail);
    expect(firstLoginBody.status).toBe("active");

    // -------------------------------------------------------------------------
    // Step 2: Request Password Reset (Forgot Password)
    // -------------------------------------------------------------------------
    const forgotRes = await client.request.post("/auth/forgot-password").send({
      email: userEmail,
    });

    expect(forgotRes.status).toBe(200);
    const forgotBody = forgotRes.body as ForgotPasswordResponse;
    expect(forgotBody.message).toContain("password reset instructions have been sent");

    const user = await prisma.user.findFirstOrThrow({ where: { email: userEmail } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: user.id, consumedAt: null } });
    const issued = PasswordResetToken.issue({ userId: user.id as never });
    await prisma.passwordResetToken.create({
      data: {
        id: issued.token.id,
        userId: user.id,
        tokenHash: issued.token.tokenHash,
        expiresAt: issued.token.expiresAt,
        createdAt: issued.token.createdAt,
      },
    });

    // -------------------------------------------------------------------------
    // Step 3: Complete Password Reset with New Password
    // -------------------------------------------------------------------------
    // The endpoint takes the raw token and replaces the password hash
    const resetRes = await client.request.post("/auth/reset-password").send({
      token: issued.rawToken,
      newPassword,
    });

    expect(resetRes.status).toBe(200);
    const resetBody = resetRes.body as ResetPasswordResponse;
    expect(resetBody.status).toBe("ok");
    expect(resetBody.user.id).toBe(userId);

    // -------------------------------------------------------------------------
    // Step 4: Login with OLD password must be rejected (401)
    // -------------------------------------------------------------------------
    const failedLoginRes = await client.request.post("/auth/login").send({
      email: userEmail,
      password: initialPassword,
    });

    expect(failedLoginRes.status).toBe(401);

    // -------------------------------------------------------------------------
    // Step 5: Login with NEW password succeeds (200)
    // -------------------------------------------------------------------------
    const successLoginRes = await client.request.post("/auth/login").send({
      email: userEmail,
      password: newPassword,
    });

    expect(successLoginRes.status).toBe(200);
    const successLoginBody = successLoginRes.body as LoginResponse;
    expect(successLoginBody.id).toBe(userId);
    expect(successLoginBody.email).toBe(userEmail);
    expect(successLoginBody.accessToken).toBeDefined();
    expect(successLoginBody.refreshToken).toBeDefined();
  });
});
