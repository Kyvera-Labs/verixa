import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";

import { bootApp, type BootedApp } from "./harness/boot-app.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface E2eEnvironment {
  readonly app: BootedApp;
  readonly stop: () => Promise<void>;
}

/** Starts disposable backing services, applies real migrations, and boots the API. */
export async function startE2eEnvironment(): Promise<E2eEnvironment> {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("verixa_e2e")
    .withUsername("verixa")
    .withPassword("verixa")
    .withStartupTimeout(120_000)
    .start();
  let redis: StartedTestContainer | undefined;
  let app: BootedApp | undefined;
  const stop = async (): Promise<void> => {
    try {
      await app?.stop();
    } finally {
      try {
        await redis?.stop();
      } finally {
        await postgres.stop();
      }
    }
  };
  try {
    redis = await new GenericContainer("redis:7-alpine")
      .withExposedPorts(6379)
      .withStartupTimeout(120_000)
      .start();
    const databaseUrl = postgres.getConnectionUri();
    execFileSync("pnpm", ["--filter", "@verixa/database", "run", "db:migrate:deploy"], {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    });
    app = await bootApp({
      databaseUrl,
      redisUrl: `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`,
    });
    return {
      app,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
