import { RateLimitExceededError, Result, type RateLimiter } from "@verixa/shared-kernel";

import type { UserId } from "../../domain/entities/mfa-method.js";
import { BackupCodeSet } from "../../domain/services/backup-code-set.js";
import type { AuditLogger } from "../ports/audit-logger.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";

export interface ConsumeBackupCodeCommand {
  readonly userId: string;
  readonly code: string;
}

export type ConsumeBackupCodeOutcome =
  | { readonly kind: "ok"; readonly codesRemaining: number }
  | { readonly kind: "exhausted" }
  | { readonly kind: "failed" };

export type ConsumeBackupCodeResult = Result<ConsumeBackupCodeOutcome, Error>;

export class ConsumeBackupCode {
  constructor(
    private readonly mfaMethodRepository: MfaMethodRepository,
    private readonly auditLogger: AuditLogger,
    private readonly rateLimiter?: RateLimiter,
  ) {}

  async execute(command: ConsumeBackupCodeCommand): Promise<ConsumeBackupCodeResult> {
    const userId = command.userId as UserId;

    if (this.rateLimiter) {
      const limitResult = await this.rateLimiter.check({
        action: "mfa",
        identifier: command.userId,
      });
      if (!limitResult.allowed) {
        await this.auditLogger.record("mfa.rate_limit_exceeded", command.userId);
        throw new RateLimitExceededError(
          { action: "mfa", identifier: command.userId },
          limitResult.resetAt,
          limitResult.limit,
        );
      }
    }

    const activeMethods = await this.mfaMethodRepository.findActiveByUserId(userId);
    const backupMethod = activeMethods.find((m) => m.type === "backup_codes");

    if (!backupMethod || !backupMethod.secret) {
      // Intentionally taking the same time as a failure?
      // Actually we should burn time here to prevent timing attacks,
      // but without a decoy hash, we can't easily burn time.
      // For now we'll just fail.
      await this.rateLimiter?.recordFailure({ action: "mfa", identifier: command.userId });
      return Result.ok({ kind: "failed" });
    }

    const hashes = parseStoredHashes(backupMethod.secret);
    if (hashes === null) {
      await this.rateLimiter?.recordFailure({ action: "mfa", identifier: command.userId });
      return Result.ok({ kind: "failed" });
    }

    let matchedIndex = -1;

    // Hashing is expensive. We verify sequentially until a match is found.
    // If it's an attack, they will pay the cost of verifying all remaining hashes.
    for (let i = 0; i < hashes.length; i++) {
      const isValid = await BackupCodeSet.verify(command.code, hashes[i]!);
      if (isValid) {
        matchedIndex = i;
        break;
      }
    }

    if (matchedIndex === -1) {
      await this.rateLimiter?.recordFailure({ action: "mfa", identifier: command.userId });
      await this.auditLogger.record("backup_code.failed", userId);
      return Result.ok({ kind: "failed" });
    }

    // Match found. Consume the code by removing its hash.
    hashes.splice(matchedIndex, 1);

    backupMethod.updateSecret(JSON.stringify(hashes));
    await this.mfaMethodRepository.save(backupMethod);

    await this.rateLimiter?.reset({ action: "mfa", identifier: command.userId });

    await this.auditLogger.record("backup_code.consumed", userId, {
      remaining: hashes.length.toString(),
    });

    if (hashes.length === 0) {
      return Result.ok({ kind: "exhausted" });
    }

    return Result.ok({ kind: "ok", codesRemaining: hashes.length });
  }
}

/**
 * Parses the stored backup-code hashes, checking the shape because `JSON.parse` returns `any`.
 * Returns `null` for anything that is not an array of strings, which the caller treats as a failed
 * attempt.
 */
function parseStoredHashes(secret: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.every((h) => typeof h === "string")) {
    return null;
  }

  return parsed;
}
