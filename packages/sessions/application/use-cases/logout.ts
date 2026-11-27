import { asId, Result, ValidationError } from "@verixa/shared-kernel";

import type { SessionId } from "../../domain/entities/session.js";
import type { RevocationList } from "../ports/revocation-list.js";
import type { SessionRepository } from "../ports/session-repository.js";

export interface LogoutCommand {
  readonly sessionId: string;
  /**
   * How long to keep `sessionId` on the revocation list — normally the
   * access token's own remaining lifetime. Defaults to a day, generous
   * enough to outlive any access token issued by the default
   * `SessionExpiryPolicy` even if the caller doesn't know the exact expiry.
   */
  readonly revokeUntil?: Date;
}

export type LogoutError = ValidationError;

const DEFAULT_REVOCATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Logs one session out: revokes it and adds it to `RevocationList`, so its stateless access token
 * stops working immediately rather than at expiry.
 *
 * Idempotent: logging out twice, or logging out an unknown session, succeeds. Returning
 * `NotFoundError` would let callers probe for valid session IDs.
 */
export class Logout {
  constructor(
    private readonly sessionRepository: SessionRepository,
    private readonly revocationList: RevocationList,
  ) {}

  async execute(command: LogoutCommand): Promise<Result<void, LogoutError>> {
    if (command.sessionId.trim() === "") {
      return Result.err(
        new ValidationError("sessionId is required.", { sessionId: ["is required"] }),
      );
    }

    const sessionId = asId<"SessionId">(command.sessionId) as SessionId;
    const session = await this.sessionRepository.findById(sessionId);
    if (session === undefined) {
      return Result.ok(undefined);
    }

    const now = new Date();
    await this.sessionRepository.save(session.revoke(now));
    await this.revocationList.revoke(
      sessionId,
      command.revokeUntil ?? new Date(now.getTime() + DEFAULT_REVOCATION_WINDOW_MS),
    );

    return Result.ok(undefined);
  }
}
