import { Result } from "@verixa/shared-kernel";

import type { UserId } from "../../domain/entities/mfa-method.js";
import type { AuditLogger } from "../ports/audit-logger.js";
import type { MfaMethodRepository } from "../ports/mfa-method-repository.js";
import type { MfaRecoveryAuthorizer } from "../ports/mfa-recovery-authorizer.js";
import type { SessionRevoker } from "../ports/session-revoker.js";

export interface RecoverMfaAccessCommand {
  /** The user who has lost access to every enrolled factor and backup code. */
  readonly targetUserId: string;
  /** The elevated actor performing the recovery. */
  readonly actorId: string;
  /** Free-text justification, recorded in the audit log. */
  readonly reason: string;
}

export interface RecoverMfaAccessResult {
  readonly methodsCleared: number;
  readonly sessionsRevoked: number;
}

export interface RecoverMfaAccessDeps {
  readonly mfaMethodRepository: MfaMethodRepository;
  readonly sessionRevoker: SessionRevoker;
  readonly authorizer: MfaRecoveryAuthorizer;
  readonly auditLogger: AuditLogger;
}

/**
 * Last-resort recovery for a user who lost every MFA method and backup code.
 *
 * Never self-service: recovery paths are a common target for social engineering, so it requires an
 * authorized, audit-logged action by a different principal (`MfaRecoveryAuthorizer`), and the actor
 * is always recorded.
 *
 * 1. Clears every enrolled method (active, pending and disabled), so a pending method whose secret
 *    an attacker saw cannot survive.
 * 2. Revokes all sessions, since the lost device may still hold one.
 * 3. Leaves no methods, so a `required` policy reports `requiresEnrollment` and forces
 *    re-enrollment at the next login.
 */
export class RecoverMfaAccess {
  constructor(private readonly deps: RecoverMfaAccessDeps) {}

  async execute(command: RecoverMfaAccessCommand): Promise<Result<RecoverMfaAccessResult, Error>> {
    // A user cannot recover their own access this way; that would make the
    // authorization gate meaningless for anyone who has a valid session.
    if (command.actorId === command.targetUserId) {
      return Result.err(new Error("MFA recovery cannot be self-triggered."));
    }

    const authorized = await this.deps.authorizer.canRecoverMfaAccess(command.actorId);
    if (!authorized) {
      return Result.err(new Error("Actor is not authorized to recover MFA access."));
    }

    const targetUserId = command.targetUserId as UserId;
    const methods = await this.deps.mfaMethodRepository.findAllByUserId(targetUserId);
    for (const method of methods) {
      await this.deps.mfaMethodRepository.delete(method.id);
    }

    const sessionsRevoked = await this.deps.sessionRevoker.revokeAllForUser(command.targetUserId);

    await this.deps.auditLogger.record("mfa.recovery.performed", command.actorId, {
      targetUserId: command.targetUserId,
      reason: command.reason,
      methodsCleared: String(methods.length),
      sessionsRevoked: String(sessionsRevoked),
    });

    return Result.ok({ methodsCleared: methods.length, sessionsRevoked });
  }
}
