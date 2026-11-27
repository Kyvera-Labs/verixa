import type { PrismaClient } from "@verixa/database";
import { assertValidTenantId, TENANT_CONTEXT_SETTING } from "@verixa/shared-kernel";

import type { OrganizationId } from "../../domain/entities/organization.js";

/**
 * Runs work in one transaction with `app.current_organization_id` set, so Row-Level Security
 * restricts every statement to that tenant (see docs/security/multi-tenancy.md).
 *
 * ```ts
 * const rows = await withTenantContext(prisma, orgId, (tx) =>
 *   tx.organizationMembership.findMany(), // no WHERE needed, and none trusted
 * );
 * ```
 *
 * The transaction is required: `set_config(..., true)` is transaction-scoped, so the setting can
 * never leak onto a pooled connection used by another request.
 */
export async function withTenantContext<T>(
  prisma: PrismaClient,
  organizationId: OrganizationId,
  work: (tx: PrismaClient) => Promise<T>,
): Promise<T> {
  assertValidTenantId(organizationId);

  return prisma.$transaction(async (tx) => {
    // Parameterized, not interpolated: `SET LOCAL` cannot take bind
    // parameters, so it would require concatenating this value into SQL — an
    // injection sink in the one place a mistake defeats tenant isolation.
    // `set_config` is a normal function call and binds properly.
    await tx.$executeRaw`SELECT set_config(${TENANT_CONTEXT_SETTING}, ${organizationId}, true)`;

    // Same narrowing as PrismaUnitOfWork: the transaction client is a
    // PrismaClient minus the methods that make no sense inside a transaction.
    return work(tx as unknown as PrismaClient);
  });
}
