import { BaseDomainEvent } from "@verixa/shared-kernel";

import type { RefreshTokenId } from "../entities/refresh-token.js";
import type { SessionId, SessionUserId } from "../entities/session.js";

/**
 * Raised when an already-rotated refresh token is presented again. A legitimate client only holds
 * the latest token, so this indicates a stolen copy, and the whole session is revoked (see
 * docs/security/threat-model-sessions.md).
 */
export class RefreshTokenReuseDetected extends BaseDomainEvent {
  readonly eventName = "sessions.refresh_token.reuse_detected";
  readonly userId: SessionUserId;
  readonly refreshTokenId: RefreshTokenId;

  constructor(sessionId: SessionId, userId: SessionUserId, refreshTokenId: RefreshTokenId) {
    super(sessionId);
    this.userId = userId;
    this.refreshTokenId = refreshTokenId;
  }
}
