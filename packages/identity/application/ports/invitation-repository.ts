import type { Invitation, InvitationId } from "../../domain/entities/invitation.js";

/**
 * The persistence contract for `Invitation`. See `user-repository.ts` for
 * the general port/adapter contract conventions this mirrors.
 *
 * - `findById`/`findByToken` return `undefined` when nothing matches.
 * - `findByToken` takes the **raw** token, as the recipient presents it from
 *   their invitation email — not a hash. Hashing is the adapter's job, since
 *   only the adapter knows that the stored form is a hash at all. Callers
 *   never see or construct a hash, which is what keeps it impossible to
 *   accidentally query with the wrong one.
 * - `save` is an idempotent upsert.
 */
export interface InvitationRepository {
  findById(id: InvitationId): Promise<Invitation | undefined>;
  findByToken(token: string): Promise<Invitation | undefined>;
  save(invitation: Invitation): Promise<void>;
}
