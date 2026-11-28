import { AuthorizationError, asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionUserId } from "../../domain/entities/session.js";
import type { SessionExpiryPolicy } from "../../domain/value-objects/session-expiry-policy.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface ListActiveSessionsCommand {
  /** The id of the user making the request. */
  readonly requestingUserId: string;
  /** The id of the user whose sessions are being listed. Usually equal to `requestingUserId`. */
  readonly targetUserId: string;
  /** Whether the requester holds an admin scope entitled to read another user's sessions. Defaults to `false`. */
  readonly asAdmin?: boolean;
}

/**
 * A session shaped for display, not persistence: everything a "manage your
 * devices" screen needs and nothing a token thief could replay. There is no
 * field here that names a token, hashed or otherwise — see
 * `docs/security/token-storage.md` and `Session`'s own doc comment on why it
 * holds no token material to begin with.
 */
export interface SessionSummary {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly ipAddress: string | undefined;
  readonly userAgent: string | undefined;
}

export type ListActiveSessionsError = ValidationError | AuthorizationError;

/**
 * Returns a user's active sessions for a "manage your devices" view.
 *
 * 1. Callers see only their own sessions unless `asAdmin` is set. The interface layer must set it
 *    only for callers with an admin role; this use case trusts the flag.
 * 2. {@link SessionSummary} has no field that can carry token material, so tokens can never be
 *    serialized into a response (see docs/guides/use-cases.md).
 *
 * Revoked and expired sessions are excluded.
 */
export class ListActiveSessions {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly expiryPolicy: SessionExpiryPolicy,
  ) {}

  async execute(
    command: ListActiveSessionsCommand,
  ): Promise<Result<readonly SessionSummary[], ListActiveSessionsError>> {
    const fieldErrors: Record<string, string[]> = {};
    if (command.requestingUserId.trim() === "") {
      fieldErrors["requestingUserId"] = ["is required"];
    }
    if (command.targetUserId.trim() === "") {
      fieldErrors["targetUserId"] = ["is required"];
    }
    if (Object.keys(fieldErrors).length > 0) {
      return Result.err(new ValidationError("Invalid session listing request.", fieldErrors));
    }

    const isOwnSessions = command.requestingUserId === command.targetUserId;
    if (!isOwnSessions && command.asAdmin !== true) {
      return Result.err(new AuthorizationError("You may not list another user's sessions."));
    }

    const targetUserId = asId<"UserId">(command.targetUserId) as SessionUserId;
    const now = new Date();
    const sessions = await this.sessionRepository.findActiveByUserId(targetUserId);

    const summaries = sessions
      .filter((session) => session.isActive(this.expiryPolicy, now))
      .map((session): SessionSummary => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      }));

    return Result.ok(summaries);
  }
}
