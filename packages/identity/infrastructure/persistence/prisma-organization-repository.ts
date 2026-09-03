import type { PrismaClient } from "@verixa/database";

import type { OrganizationMembershipRepository } from "../../application/ports/organization-membership-repository.js";
import type { OrganizationRepository } from "../../application/ports/organization-repository.js";
import type { OrganizationMembership } from "../../domain/entities/organization-membership.js";
import type { Organization, OrganizationId } from "../../domain/entities/organization.js";
import type { UserId } from "../../domain/entities/user.js";

import { OrganizationMapper, OrganizationMembershipMapper } from "./organization-mapper.js";

/** Prisma-backed `OrganizationRepository`. See `prisma-user-repository.ts` for the shared conventions. */
export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: OrganizationId): Promise<Organization | undefined> {
    const row = await this.prisma.organization.findUnique({ where: { id } });
    return row === null ? undefined : OrganizationMapper.toDomain(row);
  }

  async findBySlug(slug: string): Promise<Organization | undefined> {
    // `citext` column, so this is case-insensitive without a LOWER() wrapper.
    const row = await this.prisma.organization.findUnique({ where: { slug } });
    return row === null ? undefined : OrganizationMapper.toDomain(row);
  }

  async save(organization: Organization): Promise<void> {
    const row = OrganizationMapper.toRow(organization);
    const { id, ...withoutId } = row;
    await this.prisma.organization.upsert({
      where: { id },
      create: row,
      update: withoutId,
    });
  }

  async existsBySlug(slug: string): Promise<boolean> {
    const found = await this.prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    return found !== null;
  }
}

/** Prisma-backed `OrganizationMembershipRepository`. */
export class PrismaOrganizationMembershipRepository implements OrganizationMembershipRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findActiveByUserAndOrganization(
    userId: UserId,
    organizationId: OrganizationId,
  ): Promise<OrganizationMembership | undefined> {
    // `findFirst`, not `findUnique`: the uniqueness of an *active* membership
    // is enforced by a partial index Prisma can't model, so there's no
    // generated unique-key input to query by. The database still guarantees
    // at most one row matches.
    const row = await this.prisma.organizationMembership.findFirst({
      where: { userId, organizationId, status: "active" },
    });
    return row === null ? undefined : OrganizationMembershipMapper.toDomain(row);
  }

  async findAllByOrganization(organizationId: OrganizationId): Promise<OrganizationMembership[]> {
    const rows = await this.prisma.organizationMembership.findMany({
      where: { organizationId },
      orderBy: { joinedAt: "asc" },
    });
    return rows.map((row) => OrganizationMembershipMapper.toDomain(row));
  }

  async save(membership: OrganizationMembership): Promise<void> {
    const row = OrganizationMembershipMapper.toRow(membership);
    const { id, ...withoutId } = row;
    await this.prisma.organizationMembership.upsert({
      where: { id },
      create: row,
      update: withoutId,
    });
  }
}
