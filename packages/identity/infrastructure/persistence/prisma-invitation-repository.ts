import type { InvitationRow, PrismaClient } from "@verixa/database";
import { asId, Result } from "@verixa/shared-kernel";

import type { InvitationRepository } from "../../application/ports/invitation-repository.js";
import { Invitation, type InvitationId } from "../../domain/entities/invitation.js";
import { Email } from "../../domain/value-objects/email.js";

/** Row ↔ aggregate translation for `Invitation`. */
export const InvitationMapper = {
  toDomain(row: InvitationRow): Invitation {
    const email = Email.create(row.email);
    if (Result.isErr(email)) {
      throw new Error(`invitations.id=${row.id} holds an email the domain rejects: ${row.email}`);
    }

    return Invitation.reconstitute({
      id: asId<"InvitationId">(row.id),
      organizationId: asId<"OrganizationId">(row.organizationId),
      email: email.value,
      invitedByUserId: asId<"UserId">(row.invitedByUserId),
      tokenHash: row.tokenHash,
      status: row.status,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt ?? undefined,
    });
  },

  toRow(invitation: Invitation): InvitationRow {
    return {
      id: invitation.id,
      organizationId: invitation.organizationId,
      email: invitation.email.value,
      invitedByUserId: invitation.invitedByUserId,
      tokenHash: invitation.tokenHash,
      status: invitation.status,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt ?? null,
    };
  },
};

/**
 * Prisma-backed `InvitationRepository`.
 *
 * The token handling is the interesting part: the port takes a **raw** token
 * and the database stores only a hash, so hashing lives here — the one layer
 * that knows the stored representation. Callers can't accidentally query with
 * an already-hashed value, because they never hold one.
 */
export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: InvitationId): Promise<Invitation | undefined> {
    const row = await this.prisma.invitation.findUnique({ where: { id } });
    return row === null ? undefined : InvitationMapper.toDomain(row);
  }

  async findByToken(token: string): Promise<Invitation | undefined> {
    // Hash first, then look up by the hash — a single indexed lookup on
    // `token_hash`. This is why the token hash is deterministic and unsalted:
    // a salted hash would force a full scan, comparing every row. See
    // docs/security/token-storage.md for why that tradeoff is safe here and
    // would not be for passwords.
    const row = await this.prisma.invitation.findUnique({
      where: { tokenHash: Invitation.hashToken(token) },
    });
    return row === null ? undefined : InvitationMapper.toDomain(row);
  }

  async save(invitation: Invitation): Promise<void> {
    const row = InvitationMapper.toRow(invitation);
    const { id, ...withoutId } = row;
    await this.prisma.invitation.upsert({
      where: { id },
      create: row,
      update: withoutId,
    });
  }

  /**
   * Pending invitations for an organization that have not yet lapsed.
   *
   * Expiry is filtered in SQL rather than by loading everything and calling
   * `isExpired()` in memory. Both give the same answer today; only one still
   * works when an organization has thousands of historical invitations. The
   * `expires_at` index exists for exactly this query.
   *
   * Not part of the `InvitationRepository` port — nothing in the application
   * layer needs it yet. It lives here rather than being speculatively added
   * to the port, so the port keeps describing what use cases actually
   * require.
   */
  async findActiveByOrganization(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<Invitation[]> {
    const rows = await this.prisma.invitation.findMany({
      where: { organizationId, status: "pending", expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => InvitationMapper.toDomain(row));
  }
}
