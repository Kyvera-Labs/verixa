import {
  AuthenticationError,
  RateLimitExceededError,
  Result,
  type RateLimiter,
} from "@verixa/shared-kernel";

import { RefreshToken } from "../../domain/entities/refresh-token.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionRepository } from "../ports/session-repository.js";
import type { TokenSigner } from "../ports/token-signer.js";

export interface RefreshAccessTokenCommand {
  readonly refreshToken: string;
  readonly identifier?: string;
}

export interface RefreshedAccessToken {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export type RefreshAccessTokenError = AuthenticationError;

/**
 * Redeems a refresh token for a new token pair, rotating the refresh token. Every failure (unknown,
 * expired, revoked session or reused token) is the same {@link AuthenticationError}, so a stolen
 * token's holder learns nothing (see docs/security/authentication-flows.md). The rate limiter is
 * checked first.
 *
 * Presenting an already-rotated token means someone else has a copy, so the whole session is
 * revoked (see `Session.revokeDueToRefreshTokenReuse`).
 */
export class RefreshAccessToken {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly tokenSigner: TokenSigner,
    private readonly revocationList: RevocationList,
    private readonly expiryPolicy: SessionExpiryPolicy,
    private readonly rateLimiter?: RateLimiter,
  ) {}

  async execute(
    command: RefreshAccessTokenCommand,
  ): Promise<Result<RefreshedAccessToken, RefreshAccessTokenError>> {
    const tokenHash = RefreshToken.hashToken(command.refreshToken);
    const identifier = command.identifier ?? tokenHash;

    if (this.rateLimiter) {
      const limitResult = await this.rateLimiter.check({
        action: "refresh-token",
        identifier,
      });
      if (!limitResult.allowed) {
        throw new RateLimitExceededError(
          { action: "refresh-token", identifier },
          limitResult.resetAt,
          limitResult.limit,
        );
      }
    }

    const presented = await this.sessionRepository.findRefreshTokenByHash(tokenHash);
    if (presented === undefined) {
      await this.rateLimiter?.recordFailure({ action: "refresh-token", identifier });
      return Result.err(new AuthenticationError());
    }

    const session = await this.sessionRepository.findById(presented.sessionId);
    if (session === undefined) {
      await this.rateLimiter?.recordFailure({ action: "refresh-token", identifier });
      return Result.err(new AuthenticationError());
    }

    const now = new Date();

    if (presented.isUsed) {
      await this.rateLimiter?.recordFailure({ action: "refresh-token", identifier });
      const revokedSession = session.revokeDueToRefreshTokenReuse(presented.id, now);
      await this.sessionRepository.save(revokedSession);
      await this.revocationList.revoke(revokedSession.id, this.accessTokenExpiryFrom(now));
      return Result.err(new AuthenticationError());
    }

    if (!presented.isRedeemable(now) || !session.isActive(this.expiryPolicy, now)) {
      await this.rateLimiter?.recordFailure({ action: "refresh-token", identifier });
      return Result.err(new AuthenticationError());
    }

    const usedToken = presented.markUsed(now);
    const { refreshToken: nextRefreshToken, token: rawNextToken } = RefreshToken.issue({
      sessionId: session.id,
      expiresAt: this.expiryPolicy.refreshTokenExpiryFrom(now),
      now,
    });
    const touchedSession = session.touch(now);

    await this.sessionRepository.saveRefreshToken(usedToken);
    await this.sessionRepository.saveRefreshToken(nextRefreshToken);
    await this.sessionRepository.save(touchedSession);

    const accessToken = await this.tokenSigner.sign(
      { sessionId: touchedSession.id, userId: touchedSession.userId },
      Math.floor(this.expiryPolicy.accessTokenTtlMs / 1000),
    );

    await this.rateLimiter?.reset({ action: "refresh-token", identifier });

    return Result.ok({ accessToken, refreshToken: rawNextToken });
  }

  private accessTokenExpiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.expiryPolicy.accessTokenTtlMs);
  }
}
