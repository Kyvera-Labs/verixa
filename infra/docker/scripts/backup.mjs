#!/usr/bin/env node
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { composeArguments, runDocker } from "./compose-command.mjs";

/**
 * Production backups are taken from the running containers,
 * not from a stopped database directory. `pg_dump` gives a transactionally
 * consistent Postgres snapshot; `redis-cli --rdb` asks Redis to write a point
 * in-time RDB even though AOF is the primary persistence mode.
 *
 * @param {{ composeFiles: string[], envFile?: string, outputDirectory: string, label?: string, postgresDatabase?: string }} options
 */
export function createBackupPlan(options) {
  const label = options.label ?? `verixa-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const postgresFile = join(options.outputDirectory, `postgres-${label}.dump`);
  const redisFile = join(options.outputDirectory, `redis-${label}.rdb`);
  const compose = composeArguments(options);
  const redisContainerPath = "/tmp/verixa-backup.rdb";

  return {
    postgresFile,
    redisFile,
    steps: [
      {
        name: "postgres",
        argv: [
          ...compose,
          "exec",
          "-T",
          // Forward the credentials from the operator's environment. Passing
          // them as `-e KEY=value` would put a production password in the
          // process list and CI logs.
          "-e",
          "PGUSER",
          "-e",
          "PGPASSWORD",
          "postgres",
          "pg_dump",
          "--format=custom",
          "--no-owner",
          "--no-privileges",
          "--dbname",
          options.postgresDatabase ?? "verixa",
        ],
        outputFile: postgresFile,
      },
      {
        name: "redis-dump",
        argv: [
          ...compose,
          "exec",
          "-T",
          "-e",
          "REDISCLI_AUTH",
          "redis",
          "redis-cli",
          "--rdb",
          redisContainerPath,
        ],
      },
      {
        name: "redis-copy",
        argv: [...compose, "cp", `redis:${redisContainerPath}`, redisFile],
        outputFile: redisFile,
      },
    ],
  };
}

/**
 * @param {Parameters<typeof createBackupPlan>[0]} options
 * @param {(argv: string[], opts: { outputFile?: string, stdinFile?: string }) => Promise<string>} [runner]
 */
export async function performBackup(options, runner = runDocker) {
  const plan = createBackupPlan(options);
  mkdirSync(options.outputDirectory, { recursive: true });
  for (const step of plan.steps) {
    await runner(step.argv, {
      outputFile: step.outputFile,
      ...(step.stdinFile ? { stdinFile: step.stdinFile } : {}),
    });
  }
  try {
    chmodSync(plan.redisFile, 0o644);
  } catch {
    // Ignore if runner did not create file directly (e.g. mocked in tests)
  }
  return plan;
}

function parseArgs(argv) {
  const options = {
    composeFiles: ["docker-compose.prod.yml"],
    outputDirectory: "backups",
    label: undefined,
    envFile: undefined,
    postgresDatabase: "verixa",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--compose-file":
        options.composeFiles.push(value);
        index += 1;
        break;
      case "--env-file":
        options.envFile = value;
        index += 1;
        break;
      case "--output-dir":
        options.outputDirectory = value;
        index += 1;
        break;
      case "--label":
        options.label = value;
        index += 1;
        break;
      case "--db":
        options.postgresDatabase = value;
        index += 1;
        break;
      default:
        throw new Error(`unknown backup option: ${argv[index]}`);
    }
  }
  return options;
}

if (process.argv[1] && process.argv[1].endsWith("backup.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  try {
    const plan = await performBackup(options);
    console.log(`Wrote ${plan.postgresFile}`);
    console.log(`Wrote ${plan.redisFile}`);
    console.log("A backup you have never restored is not a backup. Run restore.mjs in a drill.");
  } catch (error) {
    console.error(`backup: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
