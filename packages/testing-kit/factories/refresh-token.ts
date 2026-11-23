import {
  type IssuedRefreshToken,
  RefreshToken,
  type RefreshTokenId,
  type SessionId,
} from "@verixa/sessions";
import { asId, createId } from "@verixa/shared-kernel";

export interface RefreshTokenFactoryOptions {
  id?: RefreshTokenId | string;
  sessionId?: SessionId | string;
  expiresAt?: Date;
  now?: Date;
}

/**
 * Creates a domain-valid `IssuedRefreshToken` fixture with sensible defaults and optional overrides.
 */
export function makeRefreshToken(overrides: RefreshTokenFactoryOptions = {}): IssuedRefreshToken {
  const sessionId = (overrides.sessionId
    ? typeof overrides.sessionId === "string"
      ? asId<"SessionId">(overrides.sessionId)
      : overrides.sessionId
    : createId<"SessionId">()) as unknown as SessionId;

  const now = overrides.now ?? new Date();
  const expiresAt = overrides.expiresAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return RefreshToken.issue({
    sessionId,
    expiresAt,
    now,
  });
}
