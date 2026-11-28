import type { Invitation, InvitationId } from "../../domain/entities/invitation.js";

/**
 * Persistence port for `Invitation`.
 *
 * - `findById` and `findByToken` return `undefined` when nothing matches.
 * - `findByToken` takes the raw token as presented by the recipient; hashing is the adapter's job,
 *   so callers never handle hashes.
 * - `save` is an idempotent upsert.
 */
export interface InvitationRepository {
  findById(id: InvitationId): Promise<Invitation | undefined>;
  findByToken(token: string): Promise<Invitation | undefined>;
  save(invitation: Invitation): Promise<void>;
}
