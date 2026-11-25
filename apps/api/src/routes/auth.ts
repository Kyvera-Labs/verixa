import { clearedSessionCookies, REFRESH_COOKIE_NAME, sessionCookies } from "@verixa/sessions";
import { AccountLockedError, Result } from "@verixa/shared-kernel";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import { z } from "zod";

import type { Container } from "../composition-root.js";
import { sendApiError, sendDomainError, sendError } from "../http/error-response.js";
import { registerZodSchema } from "../openapi/zod-registry.js";

/**
 * JSON Schema for the registration body.
 *
 * Validates **shape only** — types and presence. Rules like "at least 12
 * characters" are deliberately absent, even though Fastify supports
 * `minLength`, because the password policy lives in `RawPassword` and
 * duplicating it here would create two sources of truth that drift: someone
 * raises the minimum in the domain, the schema still accepts 8, and the
 * mismatch surfaces as a confusing 400 that names a rule nobody can find.
 *
 * The split: schema rejects requests that are malformed. The domain rejects
 * requests that are well-formed and wrong.
 */
const registerBodyZodSchema = z
  .object({
    email: z.string(),
    displayName: z.string(),
    password: z.string(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
  })
  .strict();

type RegisterBody = z.infer<typeof registerBodyZodSchema>;

/**
 * JSON Schema for the login body.
 *
 * Shape only, and noticeably thinner than registration's — no `minLength` on
 * the password, no format check on the email. That is the same rule applied
 * for a sharper reason: on this endpoint, a 400 saying "email must be a valid
 * email" tells an attacker their input never reached the credential lookup,
 * which is one more bit than a failed login should give away. Malformed
 * addresses are rejected by the use case, as failed logins, indistinguishable
 * from every other kind.
 */
const loginBodyZodSchema = z.object({ email: z.string(), password: z.string() }).strict();

type LoginBody = z.infer<typeof loginBodyZodSchema>;

const verifyEmailBodyZodSchema = z.object({ token: z.string() }).strict();
type VerifyEmailBody = z.infer<typeof verifyEmailBodyZodSchema>;

const refreshBodyZodSchema = z.object({ refreshToken: z.string().optional() }).strict();
type RefreshBody = z.infer<typeof refreshBodyZodSchema>;

const logoutBodyZodSchema = z.object({ sessionId: z.string().optional() }).strict();
type LogoutBody = z.infer<typeof logoutBodyZodSchema>;

const forgotPasswordBodyZodSchema = z.object({ email: z.string() }).strict();
type ForgotPasswordBody = z.infer<typeof forgotPasswordBodyZodSchema>;

const resetPasswordBodyZodSchema = z
  .object({
    token: z.string(),
    newPassword: z.string(),
  })
  .strict();
type ResetPasswordBody = z.infer<typeof resetPasswordBodyZodSchema>;

/**
 * Authentication routes.
 *
 * Handlers here do one thing: translate HTTP to a use case and back. No
 * business logic, no repository access, no knowledge of Prisma. That is what
 * keeps the use cases testable without an HTTP server, and it is the pattern
 * every route added later should copy.
 *
 * Generic over the logger type for the same reason `buildApp` does not
 * annotate its return as a plain `FastifyInstance`: the app is built with a
 * concrete pino `Logger`, which is not structurally identical to Fastify's
 * own `FastifyBaseLogger` (Fastify's does not require `msgPrefix`). Pinning
 * the default here would reject the very instance `buildApp` produces.
 */
export function registerAuthRoutes<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  container: Container,
): void {
  const registerBodySchema = registerZodSchema(app, "RegisterBody", registerBodyZodSchema);
  const loginBodySchema = registerZodSchema(app, "LoginBody", loginBodyZodSchema);
  const verifyEmailBodySchema = registerZodSchema(app, "VerifyEmailBody", verifyEmailBodyZodSchema);
  const refreshBodySchema = registerZodSchema(app, "RefreshBody", refreshBodyZodSchema);
  const logoutBodySchema = registerZodSchema(app, "LogoutBody", logoutBodyZodSchema);
  const forgotPasswordBodySchema = registerZodSchema(
    app,
    "ForgotPasswordBody",
    forgotPasswordBodyZodSchema,
  );
  const resetPasswordBodySchema = registerZodSchema(
    app,
    "ResetPasswordBody",
    resetPasswordBodyZodSchema,
  );

  app.post<{ Body: RegisterBody }>(
    "/register",
    { schema: { body: registerBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.registerUserWithPassword.execute({
          email: request.body.email,
          displayName: request.body.displayName,
          password: request.body.password,
          ...(request.body.givenName === undefined ? {} : { givenName: request.body.givenName }),
          ...(request.body.familyName === undefined ? {} : { familyName: request.body.familyName }),
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        // Responds with the user, never the credential. The hash is redacted
        // from serialization anyway (see Credential.toJSON), but the right
        // answer is not to put it in the response object at all — belt and
        // braces, because a future refactor could change either one.
        const { user } = result.value;

        // Audited at the boundary, after the use case succeeded. Deliberately
        // not awaited into the response path's error handling: `RecordAuditEvent`
        // never throws, because a failed audit write must not turn a successful
        // registration into an error the user sees.
        await container.audit.recordEvent.execute({
          action: "user.registered",
          subjectId: user.id,
          metadata: { email: user.email.value },
        });

        await reply.status(201).send({
          id: user.id,
          email: user.email.value,
          displayName: user.displayName.value,
          status: user.status,
          createdAt: user.createdAt.toISOString(),
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    "/login",
    { schema: { body: loginBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.authenticateWithPassword.execute({
          email: request.body.email,
          password: request.body.password,
        });

        if (Result.isErr(result)) {
          await container.audit.recordEvent.execute({
            action:
              result.error instanceof AccountLockedError ? "user.locked_out" : "user.login_failed",
            metadata: { email: request.body.email },
          });

          sendDomainError(reply, result.error);
          return;
        }

        if (result.value.status !== undefined) {
          reply.log.error(
            { status: result.value.status },
            "AuthenticateWithPassword returned an MFA-flow result, but /auth/login does not " +
              "yet handle one.",
          );
          sendApiError(reply, "NOT_IMPLEMENTED", "MFA login is not yet supported.");
          return;
        }

        const { user } = result.value;

        await container.audit.recordEvent.execute({
          action: "user.login_succeeded",
          actorId: user.id,
          subjectId: user.id,
        });

        let sessionData: { sessionId?: string; accessToken?: string; refreshToken?: string } = {};
        if (container.sessions !== undefined) {
          const userAgent = request.headers["user-agent"];
          const sessionResult = await container.sessions.issueSession.execute({
            userId: user.id,
            ipAddress: request.ip,
            ...(userAgent !== undefined ? { userAgent } : {}),
          });
          if (Result.isOk(sessionResult)) {
            sessionData = {
              sessionId: sessionResult.value.sessionId,
              accessToken: sessionResult.value.accessToken,
              refreshToken: sessionResult.value.refreshToken,
            };
            const cookies = sessionCookies({
              refreshToken: sessionResult.value.refreshToken,
              csrfToken: sessionResult.value.sessionId,
              sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
              csrfMaxAgeSeconds: 30 * 24 * 60 * 60,
            });
            reply.header("Set-Cookie", cookies);
          }
        }

        await reply.status(200).send({
          id: user.id,
          email: user.email.value,
          displayName: user.displayName.value,
          status: user.status,
          ...sessionData,
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: VerifyEmailBody }>(
    "/verify-email",
    { schema: { body: verifyEmailBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.confirmEmailVerification.execute({
          token: request.body.token,
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        const { user } = result.value;
        await container.audit.recordEvent.execute({
          action: "user.email_verified",
          actorId: user.id,
          subjectId: user.id,
        });

        await reply.status(200).send({
          status: "ok",
          user: {
            id: user.id,
            email: user.email.value,
            displayName: user.displayName.value,
            status: user.status,
          },
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: RefreshBody }>(
    "/refresh",
    { schema: { body: refreshBodySchema } },
    async (request, reply) => {
      try {
        if (container.sessions === undefined) {
          sendApiError(reply, "NOT_IMPLEMENTED", "Sessions are not enabled.");
          return;
        }

        // Check body, Authorization header, or cookie
        let refreshToken = request.body?.refreshToken;
        if (!refreshToken && request.headers.authorization) {
          const auth = request.headers.authorization;
          if (auth.startsWith("Bearer ")) {
            refreshToken = auth.slice(7);
          }
        }
        if (!refreshToken && request.headers.cookie) {
          const cookieHeader = request.headers.cookie;
          const cookiePart = cookieHeader
            .split(";")
            .map((c) => c.trim())
            .find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
          if (cookiePart) {
            refreshToken = cookiePart.slice(REFRESH_COOKIE_NAME.length + 1);
          }
        }

        if (!refreshToken) {
          sendApiError(reply, "AUTHENTICATION_FAILED", "Refresh token is required.");
          return;
        }

        const result = await container.sessions.refreshAccessToken.execute({
          refreshToken,
          identifier: request.ip,
        });
        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        const cookies = sessionCookies({
          refreshToken: result.value.refreshToken,
          csrfToken: "refreshed-csrf",
          sessionMaxAgeSeconds: 30 * 24 * 60 * 60,
          csrfMaxAgeSeconds: 30 * 24 * 60 * 60,
        });
        reply.header("Set-Cookie", cookies);

        await reply.status(200).send({
          accessToken: result.value.accessToken,
          refreshToken: result.value.refreshToken,
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: LogoutBody }>(
    "/logout",
    { schema: { body: logoutBodySchema } },
    async (request, reply) => {
      try {
        const sessionId =
          request.body?.sessionId ?? (request.headers["x-session-id"] as string | undefined);

        if (container.sessions !== undefined && sessionId) {
          await container.sessions.logout.execute({ sessionId });
        }

        reply.header("Set-Cookie", clearedSessionCookies());
        await reply.status(200).send({ status: "ok" });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: ForgotPasswordBody }>(
    "/forgot-password",
    { schema: { body: forgotPasswordBodySchema } },
    async (request, reply) => {
      try {
        await container.credentials.requestPasswordReset.execute({
          email: request.body.email,
        });

        await container.audit.recordEvent.execute({
          action: "user.password_reset_requested",
          metadata: { email: request.body.email },
        });

        // Always 200 to prevent user enumeration
        await reply.status(200).send({
          message: "If that email is registered, password reset instructions have been sent.",
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );

  app.post<{ Body: ResetPasswordBody }>(
    "/reset-password",
    { schema: { body: resetPasswordBodySchema } },
    async (request, reply) => {
      try {
        const result = await container.credentials.confirmPasswordReset.execute({
          token: request.body.token,
          newPassword: request.body.newPassword,
        });

        if (Result.isErr(result)) {
          sendDomainError(reply, result.error);
          return;
        }

        const { user } = result.value;
        await container.audit.recordEvent.execute({
          action: "user.password_reset_completed",
          actorId: user.id,
          subjectId: user.id,
        });

        await reply.status(200).send({
          status: "ok",
          user: {
            id: user.id,
            email: user.email.value,
          },
        });
      } catch (error) {
        sendError(reply, error);
      }
    },
  );
}
