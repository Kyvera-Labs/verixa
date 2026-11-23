#!/usr/bin/env node
import { existsSync } from "node:fs";

import { composeArguments, runDocker } from "./compose-command.mjs";

/**
 * Restore is destructive by design. Requiring an explicit acknowledgement
 * keeps a stale `--dump` path or a mistyped environment from wiping a live
 * database without anyone meaning to.
 *
 * @param {{ confirmEnvironment?: string, confirmed?: boolean }} options
 */
export function assertRestoreConfirmation(options) {
  if (options.confirmed || options.confirmEnvironment === "1") return;
  throw new Error(
    "set VERIXA_RESTORE_CONFIRM=1 (or pass --yes) to acknowledge a destructive restore",
  );
}

/**
 * @param {{ composeFiles: string[], envFile?: string, postgresFile: string, redisFile: string, postgresDatabase?: string }} options
 * @returns {Array<{ name: string, argv: string[], outputFile?: string, stdinFile?: string }>}
 */
export function createRestorePlan(options) {
  const compose = composeArguments(options);

  return [
    {
      name: "stop-redis",
      argv: [...compose, "stop", "redis"],
    },
    {
      // AOF takes precedence over RDB on startup. Leaving appendonlydir in
      // place would silently serve the old AOF after the RDB was copied in,
      // making the restore appear successful while restoring nothing.
      name: "clear-redis-aof",
      argv: [
        ...compose,
        "run",
        "--rm",
        "--no-deps",
        "--entrypoint",
        "sh",
        "redis",
        "-c",
        "rm -rf /data/appendonlydir /data/dump.rdb",
      ],
    },
    {
      name: "copy-redis-rdb",
      argv: [...compose, "cp", options.redisFile, "redis:/data/dump.rdb"],
    },
    {
      name: "start-redis",
      argv: [...compose, "up", "-d", "redis"],
    },
    {
      // --clean makes the result the dump's state rather than a merge on top
      // of the current one; --single-transaction makes that replacement atomic.
      name: "restore-postgres",
      argv: [
        ...compose,
        "exec",
        "-T",
        "-e",
        "PGUSER",
        "-e",
        "PGPASSWORD",
        "postgres",
        "pg_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--dbname",
        options.postgresDatabase ?? "verixa",
      ],
      stdinFile: options.postgresFile,
    },
  ];
}

/**
 * @param {Parameters<typeof createRestorePlan>[0] & { confirmEnvironment?: string, confirmed?: boolean }} options
 * @param {(argv: string[], opts: { outputFile?: string, stdinFile?: string }) => Promise<string>} [runner]
 */
export async function performRestore(options, runner = runDocker) {
  assertRestoreConfirmation(options);
  for (const file of [options.postgresFile, options.redisFile]) {
    if (!existsSync(file)) throw new Error(`backup file not found: ${file}`);
  }
  for (const step of createRestorePlan(options)) {
    await runner(step.argv, {
      ...(step.outputFile ? { outputFile: step.outputFile } : {}),
      ...(step.stdinFile ? { stdinFile: step.stdinFile } : {}),
    });
  }
}

function parseArgs(argv) {
  const options = {
    composeFiles: ["docker-compose.prod.yml"],
    envFile: undefined,
    postgresFile: undefined,
    redisFile: undefined,
    postgresDatabase: "verixa",
    confirmEnvironment: process.env.VERIXA_RESTORE_CONFIRM,
    confirmed: false,
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
      case "--dump":
        options.postgresFile = value;
        index += 1;
        break;
      case "--rdb":
        options.redisFile = value;
        index += 1;
        break;
      case "--db":
        options.postgresDatabase = value;
        index += 1;
        break;
      case "--yes":
        options.confirmed = true;
        break;
      default:
        throw new Error(`unknown restore option: ${argv[index]}`);
    }
  }
  if (!options.postgresFile || !options.redisFile) {
    throw new Error("restore requires --dump <file.dump> and --rdb <file.rdb>");
  }
  return options;
}

if (process.argv[1] && process.argv[1].endsWith("restore.mjs")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    await performRestore(options);
    console.log("Restore complete. Verify application data before resuming traffic.");
  } catch (error) {
    console.error(`restore: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
