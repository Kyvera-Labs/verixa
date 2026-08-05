import type { InvitationRepository } from "../../application/ports/invitation-repository.js";
import type { Invitation, InvitationId } from "../../domain/entities/invitation.js";

/** In-memory `InvitationRepository` — see `in-memory-user-repository.ts` for the rationale. */
export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly invitationsById = new Map<InvitationId, Invitation>();

  findById(id: InvitationId): Promise<Invitation | undefined> {
    return Promise.resolve(this.invitationsById.get(id));
  }

  findByToken(token: string): Promise<Invitation | undefined> {
    return Promise.resolve(
      [...this.invitationsById.values()].find((invitation) => invitation.token === token),
    );
  }

  save(invitation: Invitation): Promise<void> {
    this.invitationsById.set(invitation.id, invitation);
    return Promise.resolve();
  }
}
