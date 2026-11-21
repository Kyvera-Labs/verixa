import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { performBackup } from "../../infra/docker/scripts/backup.mjs";
import {
  assertRestoreConfirmation,
  createRestorePlan,
  performRestore,
} from "../../infra/docker/scripts/restore.mjs";

const directories: string[] = [];

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "verixa-backup-test-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    rmSync(directories.pop() as string, { recursive: true, force: true });
  }
});

describe("Production backup and restore (Issue 386 / #498)", () => {
  it("dumps Postgres and Redis from the running containers into separate files", async () => {
    const directory = tempDirectory();
    const calls: Array<{ argv: string[]; outputFile?: string }> = [];
    let outputCount = 0;
    const plan = await performBackup(
      {
        composeFiles: ["docker-compose.yml", "docker-compose.prod.yml"],
        outputDirectory: join(directory, "backups"),
        label: "ci",
      },
      (argv, options) => {
        const call: { argv: string[]; outputFile?: string } = { argv };
        if (options.outputFile) {
          call.outputFile = options.outputFile;
          outputCount += 1;
          writeFileSync(options.outputFile, `dump-${outputCount}`);
        }
        calls.push(call);
        return resolved("");
      },
    );

    expect(readFileSync(plan.postgresFile, "utf8")).toBe("dump-1");
    expect(readFileSync(plan.redisFile, "utf8")).toBe("dump-2");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.argv.join(" ")).toContain("exec -T -e PGUSER -e PGPASSWORD postgres pg_dump");
    expect(calls[0]!.argv).toContain("--format=custom");
    expect(calls[0]!.argv).not.toContain("--file=/dev/stdout");
    expect(calls[1]!.argv.join(" ")).toContain("redis redis-cli --rdb /tmp/verixa-backup.rdb");
    expect(calls[1]!.argv).toContain("REDISCLI_AUTH");
    expect(calls[1]!.outputFile).toBeUndefined();
    expect(calls[2]!.argv.join(" ")).toContain("cp redis:/tmp/verixa-backup.rdb");
    expect(calls[2]!.outputFile).toBe(plan.redisFile);
    expect(calls.every((call) => !call.argv.some((arg) => arg.includes("ci-secret")))).toBe(true);
  });

  it("creates a restore plan that replaces AOF with the RDB and atomically restores Postgres", () => {
    const directory = tempDirectory();
    const postgresFile = join(directory, "postgres.dump");
    const redisFile = join(directory, "redis.rdb");
    writeFileSync(postgresFile, "pg");
    writeFileSync(redisFile, "rdb");

    const plan = createRestorePlan({
      composeFiles: ["docker-compose.prod.yml"],
      postgresFile,
      redisFile,
    });
    expect(plan.map((step) => step.name)).toEqual([
      "stop-redis",
      "clear-redis-aof",
      "copy-redis-rdb",
      "start-redis",
      "restore-postgres",
    ]);
    const aof = plan.find((step) => step.name === "clear-redis-aof");
    expect(aof?.argv.join(" ")).toContain("rm -rf /data/appendonlydir /data/dump.rdb");
    const restore = plan.find((step) => step.name === "restore-postgres");
    expect(restore?.argv).toContain("--clean");
    expect(restore?.argv).toContain("--single-transaction");
    expect(restore?.stdinFile).toBe(postgresFile);
  });

  it("refuses to restore without an explicit acknowledgement", async () => {
    expect(() => assertRestoreConfirmation({})).toThrow(/VERIXA_RESTORE_CONFIRM/);
    expect(() => assertRestoreConfirmation({ confirmEnvironment: "1" })).not.toThrow();

    const directory = tempDirectory();
    const postgresFile = join(directory, "postgres.dump");
    writeFileSync(postgresFile, "pg");
    await expect(
      performRestore(
        {
          composeFiles: ["docker-compose.prod.yml"],
          postgresFile,
          redisFile: join(directory, "missing.rdb"),
          confirmEnvironment: "1",
        },
        () => resolved(""),
      ),
    ).rejects.toThrow(/backup file not found/);
  });

  it("executes every restore step once the dump files exist", async () => {
    const directory = tempDirectory();
    const postgresFile = join(directory, "postgres.dump");
    const redisFile = join(directory, "redis.rdb");
    writeFileSync(postgresFile, "pg");
    writeFileSync(redisFile, "rdb");
    const calls: string[] = [];

    await performRestore(
      {
        composeFiles: ["docker-compose.prod.yml"],
        postgresFile,
        redisFile,
        confirmed: true,
      },
      (argv) => {
        calls.push(argv.join(" "));
        return resolved("");
      },
    );
    expect(calls).toHaveLength(5);
    expect(calls[0]).toContain("stop redis");
    expect(calls[4]).toContain("pg_restore");
  });
});
