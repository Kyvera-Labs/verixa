import type { Invitation, InvitationId } from "../../domain/entities/invitation.js";

/**
 * The persistence contract for `Invitation`. See `user-repository.ts` for
 * the general port/adapter contract conventions this mirrors.
 *
 * - `findById`/`findByToken` return `undefined` when nothing matches.
 * - `findByToken` is the lookup an invitation-acceptance flow (Phase 14)
 *   actually uses: the recipient has the token (from the invitation email),
 *   not the invitation's internal id.
 * - `save` is an idempotent upsert.
 */
export interface InvitationRepository {
  findById(id: InvitationId): Promise<Invitation | undefined>;
  findByToken(token: string): Promise<Invitation | undefined>;
  save(invitation: Invitation): Promise<void>;
}
