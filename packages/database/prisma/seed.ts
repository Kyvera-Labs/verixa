import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createPrismaClient, type PrismaClient } from "../index.js";

const DEFAULT_PERMISSIONS = [
  ["users:read", "View users"],
  ["users:write", "Create and update users"],
  ["roles:read", "View roles and permissions"],
  ["roles:write", "Create and manage roles"],
  ["orgs:read", "View organizations"],
  ["orgs:write", "Manage organizations"],
  ["*:*", "Unrestricted platform administration"],
] as const;
const DEFAULT_ROLES = [
  { name: "super-admin", description: "Platform administrator", permissions: ["*:*"] },
  {
    name: "org-owner",
    description: "Organization owner",
    permissions: [
      "users:read",
      "users:write",
      "roles:read",
      "roles:write",
      "orgs:read",
      "orgs:write",
    ],
  },
  { name: "member", description: "Organization member", permissions: ["users:read", "orgs:read"] },
  {
    name: "viewer",
    description: "Read-only organization viewer",
    permissions: ["users:read", "orgs:read", "roles:read"],
  },
] as const;

async function seedDefaultRoles(prisma: PrismaClient): Promise<void> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const permissionIds = new Map<string, string>();
  for (const [key, description] of DEFAULT_PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { key },
      create: { id: randomUUID(), key, description, createdAt: now },
      update: { description },
    });
    permissionIds.set(key, row.id);
  }
  for (const definition of DEFAULT_ROLES) {
    // Located by name alone: `Role.name` is globally unique in the schema, and
    // there is no `organization_id` column on `roles`. The authorization
    // domain's `Role` carries an `orgId` and `CreateRole` enforces uniqueness
    // per organization, but no migration has ever added that column -- so this
    // file previously filtered on `organizationId: null`, which does not
    // compile against the generated client. See the note in the commit.
    const existing = await prisma.role.findUnique({
      where: { name: definition.name },
    });
    const role =
      existing === null
        ? await prisma.role.create({
            data: {
              id: randomUUID(),
              name: definition.name,
              description: definition.description,
              isSystemRole: true,
              createdAt: now,
              updatedAt: now,
            },
          })
        : await prisma.role.update({
            where: { id: existing.id },
            data: { description: definition.description, isSystemRole: true, updatedAt: now },
          });
    for (const key of definition.permissions) {
      const permissionId = permissionIds.get(key);
      if (permissionId === undefined) throw new Error(`Missing seeded permission ${key}`);
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        create: { roleId: role.id, permissionId },
        update: {},
      });
    }
  }
}

/**
 * Deterministic development fixtures: `pnpm db:seed`. Idempotent, since every record is upserted by
 * a fixed ID.
 *
 * Local development only. Every value is obviously fake (`@example.com` addresses, placeholder
 * names) and nothing here is usable as a credential. Any seeded password added later must be
 * clearly fake.
 */

// Prisma 6 read DATABASE_URL from .env by itself; Prisma 7 does not, and
// `pnpm db:seed` runs this file directly. Variables already set win.
const rootEnvFile = fileURLToPath(new URL("../../../.env", import.meta.url));
try {
  process.loadEnvFile(rootEnvFile);
} catch (error) {
  // No .env is fine (CI and containers pass variables directly).
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  throw new Error("DATABASE_URL must be set to seed the database (see .env.example)");
}
const prisma = createPrismaClient(databaseUrl);

/**
 * Fixed IDs make the seed idempotent and let a fixture be referenced across resets and machines.
 * The `4` and `8` keep them valid UUIDv4s.
 */
const IDS = {
  alice: "00000000-0000-4000-8000-000000000001",
  bob: "00000000-0000-4000-8000-000000000002",
  carol: "00000000-0000-4000-8000-000000000003",
  acme: "00000000-0000-4000-8000-00000000000a",
  globex: "00000000-0000-4000-8000-00000000000b",
  aliceAcme: "00000000-0000-4000-8000-000000000101",
  bobAcme: "00000000-0000-4000-8000-000000000102",
  bobGlobex: "00000000-0000-4000-8000-000000000103",
  carolGlobex: "00000000-0000-4000-8000-000000000104",
} as const;

// A fixed timestamp, for the same reason as fixed ids: a seed that writes
// `new Date()` produces a different database on every run, which makes
// "did my change affect this?" harder to answer than it needs to be.
const SEEDED_AT = new Date("2026-01-01T00:00:00.000Z");

async function seed(): Promise<void> {
  const users = [
    {
      id: IDS.alice,
      email: "alice@example.com",
      displayName: "Alice Ashworth",
      givenName: "Alice",
      familyName: "Ashworth",
      status: "active" as const,
    },
    {
      id: IDS.bob,
      email: "bob@example.com",
      displayName: "Bob Barker",
      givenName: "Bob",
      familyName: "Barker",
      status: "active" as const,
    },
    // Deliberately still pending: exercising a non-active status locally
    // catches "we only ever tested the happy path" bugs before review does.
    {
      id: IDS.carol,
      email: "carol@example.com",
      displayName: "Carol Chen",
      givenName: null,
      familyName: null,
      status: "pending" as const,
    },
  ];

  for (const user of users) {
    const { id, ...fields } = user;
    await prisma.user.upsert({
      where: { id },
      create: { id, ...fields, createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
      update: { ...fields, updatedAt: SEEDED_AT },
    });
  }

  const organizations = [
    { id: IDS.acme, name: "Acme Inc", slug: "acme", ownerId: IDS.alice, status: "active" as const },
    {
      id: IDS.globex,
      name: "Globex Corporation",
      slug: "globex",
      ownerId: IDS.bob,
      status: "active" as const,
    },
  ];

  for (const organization of organizations) {
    const { id, ...fields } = organization;
    await prisma.organization.upsert({
      where: { id },
      create: { id, ...fields, createdAt: SEEDED_AT, updatedAt: SEEDED_AT },
      update: { ...fields, updatedAt: SEEDED_AT },
    });
  }

  // Bob belongs to both organizations on purpose. A user spanning tenants is
  // the case that breaks naive multi-tenancy assumptions, and ADR-0002 chose
  // row-level isolation partly because it handles this without contortion —
  // so the seed should make it the default thing a contributor sees, not an
  // edge case they have to construct by hand.
  const memberships = [
    { id: IDS.aliceAcme, userId: IDS.alice, organizationId: IDS.acme, status: "active" as const },
    { id: IDS.bobAcme, userId: IDS.bob, organizationId: IDS.acme, status: "active" as const },
    { id: IDS.bobGlobex, userId: IDS.bob, organizationId: IDS.globex, status: "active" as const },
    // A revoked membership, so the partial unique index and the "revoked
    // doesn't block rejoining" rule are both visible in real data.
    {
      id: IDS.carolGlobex,
      userId: IDS.carol,
      organizationId: IDS.globex,
      status: "revoked" as const,
    },
  ];

  for (const membership of memberships) {
    const { id, ...fields } = membership;
    await prisma.organizationMembership.upsert({
      where: { id },
      create: { id, ...fields, joinedAt: SEEDED_AT },
      update: fields,
    });
  }

  await seedDefaultRoles(prisma);

  // Invitations are deliberately not seeded. An invitation is only meaningful
  // alongside the raw token that was mailed to its recipient, and that token
  // is unrecoverable by design (see docs/security/token-storage.md) — a
  // seeded invitation would be a row nobody can ever accept. Worse, seeding a
  // *known* token would put a working bearer credential in version control,
  // which is exactly what that document says never to do.

  console.log(
    `Seeded ${String(users.length)} users, ${String(organizations.length)} organizations, ` +
      `${String(memberships.length)} memberships and the default authorization catalog.`,
  );
}

seed()
  .catch((error: unknown) => {
    console.error("Seeding failed:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
