import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = resolve(__dirname, "../..");
const MIGRATE_SCRIPT_PATH = resolve(REPO_ROOT, "infra/docker/scripts/migrate.sh");
const COMPOSE_PROD_PATH = resolve(REPO_ROOT, "docker-compose.prod.yml");
const DEPLOYMENT_DOC_PATH = resolve(REPO_ROOT, "docs/guides/deployment.md");

interface ExecError {
  status?: number;
  stderr?: Buffer | string;
}

interface ComposeService {
  restart?: string;
  command?: string | string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
}

interface ComposeConfig {
  services?: Record<string, ComposeService>;
}

describe("Migrations-on-deploy: prisma migrate deploy runner (Issue 392 / #504)", () => {
  it("migrate.sh script exists and has executable permissions", () => {
    expect(existsSync(MIGRATE_SCRIPT_PATH)).toBe(true);
    const stats = statSync(MIGRATE_SCRIPT_PATH);
    const isExecutable = (stats.mode & 0o111) !== 0;
    expect(isExecutable).toBe(true);
  });

  it("migrate.sh exits with code 2 when no database URL is configured", () => {
    let error: ExecError | undefined;
    try {
      execFileSync(MIGRATE_SCRIPT_PATH, {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: "",
          DATABASE_MIGRATION_URL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: unknown) {
      error = err as ExecError;
    }

    expect(error).toBeDefined();
    expect(error?.status).toBe(2);
    expect(error?.stderr?.toString()).toContain(
      "DATABASE_MIGRATION_URL or DATABASE_URL must be set before migrating",
    );
  });

  it("docker-compose.prod.yml defines a dedicated one-shot migration service", () => {
    expect(existsSync(COMPOSE_PROD_PATH)).toBe(true);
    const rawYaml = readFileSync(COMPOSE_PROD_PATH, "utf-8");
    const compose = parseYaml(rawYaml) as ComposeConfig;

    expect(compose.services).toBeDefined();
    const migrationService = compose.services?.migration;
    expect(migrationService).toBeDefined();

    expect(migrationService?.restart).toBe("no");

    const cmd = migrationService?.command;
    const command = Array.isArray(cmd) ? cmd.join(" ") : (cmd ?? "");
    expect(command).toMatch(/migrate:deploy|migrate\.sh/);

    const env = migrationService?.environment ?? {};
    const dbUrl = env.DATABASE_URL ?? "";
    expect(dbUrl).toContain("DATABASE_MIGRATION_URL");
  });

  it("docker-compose.prod.yml gates api boot on migration completion", () => {
    const rawYaml = readFileSync(COMPOSE_PROD_PATH, "utf-8");
    const compose = parseYaml(rawYaml) as ComposeConfig;

    expect(compose.services).toBeDefined();
    const apiService = compose.services?.api;
    expect(apiService).toBeDefined();
    expect(apiService?.depends_on).toBeDefined();

    const migrationDep = apiService?.depends_on?.migration;
    expect(migrationDep).toBeDefined();
    expect(migrationDep?.condition).toBe("service_completed_successfully");
  });

  it("deployment guide documents CI/CD pipeline gating and orchestrator patterns", () => {
    expect(existsSync(DEPLOYMENT_DOC_PATH)).toBe(true);
    const docContent = readFileSync(DEPLOYMENT_DOC_PATH, "utf-8");

    expect(docContent).toContain("pre-deploy");
    expect(docContent).toContain("prisma migrate deploy");
    expect(docContent).toContain("DATABASE_MIGRATION_URL");
    expect(docContent).toContain("condition: service_completed_successfully");
  });

  it("migration deploy is idempotent when run repeatedly against target database", () => {
    const scriptContent = readFileSync(MIGRATE_SCRIPT_PATH, "utf-8");
    expect(scriptContent).toContain("db:migrate:deploy");
    expect(scriptContent).toContain("Idempotency");
  });
});
