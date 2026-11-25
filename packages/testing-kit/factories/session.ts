import {
  Session,
  SessionExpiryPolicy,
  type SessionId,
  type SessionMetadata,
  type SessionUserId,
} from "@verixa/sessions";
import { asId, createId } from "@verixa/shared-kernel";

export interface SessionFactoryOptions {
  id?: SessionId | string;
  userId?: SessionUserId | string;
  policy?: SessionExpiryPolicy;
  metadata?: SessionMetadata;
  now?: Date;
  isRevoked?: boolean;
  revokedAt?: Date;
}

/**
 * Creates a domain-valid `Session` aggregate with sensible defaults and optional overrides.
 */
export function makeSession(overrides: SessionFactoryOptions = {}): Session {
  const userId = (overrides.userId
    ? typeof overrides.userId === "string"
      ? asId<"UserId">(overrides.userId)
      : overrides.userId
    : createId<"UserId">()) as unknown as SessionUserId;

  const policy = overrides.policy ?? SessionExpiryPolicy.default();
  const now = overrides.now ?? new Date();

  let session = Session.open({
    userId,
    policy,
    metadata: overrides.metadata ?? { ipAddress: "127.0.0.1", userAgent: "testing-kit-agent" },
    now,
  });

  if (overrides.id || overrides.isRevoked !== undefined || overrides.revokedAt !== undefined) {
    const id = overrides.id
      ? typeof overrides.id === "string"
        ? asId<"SessionId">(overrides.id)
        : overrides.id
      : session.id;

    const revokedAt =
      overrides.revokedAt ??
      (overrides.isRevoked ? now : overrides.isRevoked === false ? undefined : session.revokedAt);

    session = Session.reconstitute({
      id,
      userId: session.userId,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      revokedAt,
    });
  }

  return session;
}
