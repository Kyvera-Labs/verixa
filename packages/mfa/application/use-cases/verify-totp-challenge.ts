import {
  AccountLockedError,
  RateLimitExceededError,
  Result,
  ValidationError,
  asId,
  type RateLimiter,
} from "@verixa/shared-kernel";

import type { TotpAlgorithm } from "../../domain/services/totp-algorithm.js";
import type { AuditLogger } from "../ports/audit-logger.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";

export interface VerifyTotpChallengeCommand {
  readonly methodId: string;
  readonly code: string;
}

export type VerifyTotpChallengeError = Error | AccountLockedError | ValidationError;

/**
 * Verifies a submitted TOTP code against an active method during login or step-up.
 *
 * Allows a minor configurable clock drift (e.g. �1 step) but strictly rejects
 * code reuse within the same step. On success, updates the method's lastUsedAt
 * and lastUsedStep to prevent replay.
 */
export class VerifyTotpChallenge {
  constructor(
    private readonly mfaMethodRepository: MfaMethodRepository,
    private readonly totpAlgorithm: TotpAlgorithm,
    private readonly rateLimiter?: RateLimiter,
    private readonly auditLogger?: AuditLogger,
  ) {}

  async execute(
    command: VerifyTotpChallengeCommand,
  ): Promise<Result<void, VerifyTotpChallengeError>> {
    if (!command.code || command.code.length !== 6) {
      return Result.err(new ValidationError("TOTP code must be 6 digits."));
    }

    const methodId = asId<"MfaMethodId">(command.methodId);
    const method = await this.mfaMethodRepository.findById(methodId);

    if (!method) {
      return Result.err(new Error("MFA method not found."));
    }

    if (method.status !== "active") {
      return Result.err(new Error("Method is not active."));
    }

    const now = new Date();
    if (method.isLockedAt(now)) {
      return Result.err(new AccountLockedError("Authentication attempts are rate-limited."));
    }

    if (this.rateLimiter) {
      const limitResult = await this.rateLimiter.check({
        action: "mfa",
        identifier: method.userId,
      });
      if (!limitResult.allowed) {
        if (this.auditLogger) {
          await this.auditLogger.record("mfa.rate_limit_exceeded", method.userId, {
            methodId: method.id,
          });
        }
        throw new RateLimitExceededError(
          { action: "mfa", identifier: method.userId },
          limitResult.resetAt,
          limitResult.limit,
        );
      }
    }

    if (!method.secret) {
      return Result.err(new Error("MFA method is missing its secret."));
    }

    // Verify code, allowing �1 drift window (30s past or future)
    const matchedStep = await this.totpAlgorithm.verify(method.secret, command.code, 1);

    if (matchedStep === null) {
      await this.rateLimiter?.recordFailure({ action: "mfa", identifier: method.userId });
      const updatedMethod = method.recordFailedAttempt(now);
      await this.mfaMethodRepository.save(updatedMethod);
      return Result.err(new Error("Invalid TOTP code."));
    }

    try {
      // Record use updates lastUsedAt and enforces replay protection against the matchedStep
      const verifiedMethod = method.recordTotpUse(matchedStep, now);
      await this.mfaMethodRepository.save(verifiedMethod);
      await this.rateLimiter?.reset({ action: "mfa", identifier: method.userId });
      return Result.ok(undefined);
    } catch {
      // Replay detected
      await this.rateLimiter?.recordFailure({ action: "mfa", identifier: method.userId });
      const updatedMethod = method.recordFailedAttempt(now);
      await this.mfaMethodRepository.save(updatedMethod);
      return Result.err(new Error("Code has already been used."));
    }
  }
}
