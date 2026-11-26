// Prisma CLI configuration (Prisma 7 moved this out of schema.prisma and
// package.json#prisma). It is read by `prisma generate`, `migrate` and `db`
// commands only; the runtime client gets its connection from
// createPrismaClient() in index.ts instead.
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";

// Prisma 6 loaded `.env` itself; Prisma 7 does not. Load the repo-root `.env`
// (see .env.example) when there is one. Variables already set in the
// environment win, so CI and migrate.sh keep full control.
const rootEnvFile = fileURLToPath(new URL("../../.env", import.meta.url));
try {
  process.loadEnvFile(rootEnvFile);
} catch (error) {
  // No .env is fine (CI and containers pass variables directly).
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  // Plain process.env rather than prisma/config's env(), which throws when the
  // variable is unset. `prisma generate` and `prisma validate` need no
  // database, and the Docker build runs them without one.
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
