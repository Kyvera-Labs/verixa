import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionUserId } from "../../domain/entities/session.js";
import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface LogoutEverywhereCommand {
  readonly userId: string;
}

export type LogoutEverywhereError = ValidationError;

const DEFAULT_REVOCATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Revokes all of a user's active sessions: "log out all devices", password reset (through
 * credentials' `SessionRevoker`) and admin lockdown. Idempotent.
 *
 * It loads each session rather than running one bulk UPDATE because each session ID must be added
 * to `RevocationList` anyway. Sessions created concurrently after the read are not affected, which
 * is intended.
 */
export class LogoutEverywhere {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly revocationList: RevocationList,
  ) {}

  async execute(command: LogoutEverywhereCommand): Promise<Result<void, LogoutEverywhereError>> {
    if (command.userId.trim() === "") {
      return Result.err(new ValidationError("userId is required.", { userId: ["is required"] }));
    }

    const userId = asId<"UserId">(command.userId) as SessionUserId;
    const now = new Date();
    const revokeUntil = new Date(now.getTime() + DEFAULT_REVOCATION_WINDOW_MS);

    // Revoked in the deny-list *before* the repository write, not after:
    // this is the check every still-valid access token is validated against,
    // so it must already be in place before any caller could possibly learn
    // the sessions were revoked and go looking for a window in which their
    // token still works.
    const activeSessions = await this.sessionRepository.findActiveByUserId(userId);
    await Promise.all(
      activeSessions.map((session) => this.revocationList.revoke(session.id, revokeUntil)),
    );

    await this.sessionRepository.revokeAllForUser(userId, now);

    return Result.ok(undefined);
  }
}
