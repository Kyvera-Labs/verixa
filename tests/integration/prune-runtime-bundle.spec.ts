import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

/**
 * The bundle-pruning step the API image build runs (roadmap Issue 216).
 *
 * The Dockerfile is the only consumer, and a laptop with no Docker daemon
 * cannot build it — so the script the image calls is tested here the way the
 * image calls it: as a subprocess over a directory. What is deliberately *not*
 * covered locally is the image itself; the `docker` job in `ci.yml` asserts the
 * shipped contents, and `container-scan.yml` scans them.
 */

const run = promisify(execFile);
const script = fileURLToPath(new URL("../../scripts/prune-runtime-bundle.mjs", import.meta.url));

interface PruneResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A prune run that reports its exit state instead of throwing.
 *
 * A non-zero exit is the behaviour under test in two of the cases below, so the
 * helper takes the rejection apart rather than making each test reach for a
 * `try`/`catch`.
 */
async function prune(args: readonly string[]): Promise<PruneResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [script, ...args]);

    return { code: 0, stdout, stderr };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string };

    return {
      code: failure.code ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

async function makeBundle(files: readonly string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "verixa-bundle-"));

  for (const file of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `// ${file}\n`);
  }

  return root;
}

describe("prune-runtime-bundle", () => {
  const residue = [
    "dist/server.js.map",
    "dist/index.d.ts",
    "dist/index.d.ts.map",
    "dist/auth.spec.js",
    "dist/auth.spec.js.map",
    "node_modules/@verixa/database/dist/index.js.map",
    "node_modules/@verixa/database/dist/index.d.ts",
    "node_modules/.pnpm/@prisma+client@6.8.2/node_modules/@prisma/client/index.d.ts",
  ];

  const shipped = [
    "dist/server.js",
    "dist/app.js",
    "package.json",
    "node_modules/@verixa/database/dist/index.js",
    "node_modules/.pnpm/@prisma+client@6.8.2/node_modules/@prisma/client/index.js",
    "node_modules/.pnpm/@prisma+client@6.8.2/node_modules/.prisma/client/schema.prisma",
    "LICENSE",
  ];

  it("removes source maps, type declarations and compiled specs, and keeps the rest", async () => {
    const root = await makeBundle([...residue, ...shipped]);

    expect((await prune([root])).code).toBe(0);

    for (const file of residue) {
      await expect(readFile(path.join(root, file), "utf8")).rejects.toThrow();
    }

    for (const file of shipped) {
      await expect(readFile(path.join(root, file), "utf8")).resolves.toContain(file);
    }
  });

  it("names what it removed, because the hardening doc and the build log both have to be checked", async () => {
    const root = await makeBundle(residue);

    const { stdout } = await prune([root]);

    expect(stdout).toContain("pruned 3 .js.map file(s)");
    expect(stdout).toContain("pruned 1 .spec.js file(s)");
    expect(stdout).toContain("pruned 3 .d.ts file(s)");
    expect(stdout).toContain("pruned 1 .d.ts.map file(s)");
    expect(stdout).toContain(`pruned ${String(residue.length)} entry(s)`);
    expect(stdout).toContain(root);
  });

  it("succeeds quietly on a bundle with nothing to remove", async () => {
    const root = await makeBundle(shipped);

    const { code, stdout } = await prune([root]);

    expect(code).toBe(0);
    expect(stdout).toContain("pruned 0 entry(s)");
  });

  it.skipIf(process.platform === "win32")(
    "does not follow symlinks out of the bundle",
    async () => {
      // A recursive delete that follows links deletes through paths that point
      // wherever the link does, and a `pnpm` store is made of links. The walk
      // has to refuse them rather than be clever about them.
      //
      // Skipped on Windows rather than silently passing there: creating a
      // symlink needs developer mode or elevation, and a suite that fails for a
      // reason unrelated to the code is worse than one that reports the skip.
      // CI is Linux, so the case is enforced on every push.
      const outside = await makeBundle(["secret.js.map"]);
      const root = await makeBundle(["dist/server.js"]);

      await symlink(path.join(outside, "secret.js.map"), path.join(root, "linked.js.map"));

      const { stdout } = await prune([root]);

      expect(stdout).toContain("pruned 0 entry(s)");
      await expect(readFile(path.join(outside, "secret.js.map"), "utf8")).resolves.toContain(
        "secret.js.map",
      );
    },
  );

  it("reports a directory that is not there instead of claiming success", async () => {
    const { code, stdout, stderr } = await prune([
      path.join(tmpdir(), "verixa-bundle-does-not-exist"),
    ]);

    expect(code).toBe(1);
    expect(stdout).not.toContain("pruned");
    expect(stderr).toContain("is not a directory");
  });

  it("requires a target", async () => {
    const { code, stderr } = await prune([]);

    expect(code).toBe(2);
    expect(stderr).toContain("usage: prune-runtime-bundle.mjs <directory>");
  });
});

/**
 * `pnpm deploy` copies each workspace package directory whole, because no
 * package declares a `files` array. Without this half of the rule the shipped
 * image carries `apps/api/src/**`, every package's `domain/` and
 * `application/` trees, and the `coverage/` output of the test run that
 * happened earlier in the same stage — the source itself, not a source map of
 * it.
 */
describe("prune-runtime-bundle: workspace sources and test output", () => {
  const ours = [
    "src/server.ts",
    "src/routes/auth.spec.ts",
    "index.ts",
    "vitest.config.ts",
    "node_modules/@verixa/sessions/index.ts",
    "node_modules/@verixa/sessions/domain/refresh-token.ts",
    "node_modules/@verixa/sessions/domain/refresh-token.spec.ts",
    "node_modules/.pnpm/@verixa+config@workspace/packages/config/node_modules/@verixa/config/index.ts",
  ];

  const coverage = [
    "coverage/lcov.info",
    "coverage/lcov-report/server.js.html",
    "node_modules/@verixa/sessions/coverage/lcov.info",
  ];

  // Third-party `.ts` stays: those files belong to other projects' resolution
  // rules, and this script's boundary is what Verixa's own build put here.
  const theirs = [
    "node_modules/fastify/lib/wrapThenable.js",
    "node_modules/.pnpm/some-dep@1.0.0/node_modules/some-dep/src/index.ts",
    "node_modules/.pnpm/some-dep@1.0.0/node_modules/some-dep/package.json",
  ];

  const compiled = [
    "dist/server.js",
    "node_modules/@verixa/sessions/dist/index.js",
    "node_modules/@verixa/sessions/dist/infrastructure/http/cookie-config.js",
  ];

  it("removes the repository's own TypeScript and leaves compiled output alone", async () => {
    const root = await makeBundle([...ours, ...compiled]);

    expect((await prune([root])).code).toBe(0);

    for (const file of ours) {
      await expect(readFile(path.join(root, file), "utf8")).rejects.toThrow();
    }

    for (const file of compiled) {
      await expect(readFile(path.join(root, file), "utf8")).resolves.toContain(file);
    }
  });

  it("removes coverage directories with their contents, not just the files inside them", async () => {
    const root = await makeBundle([...coverage, "dist/server.js"]);

    expect((await prune([root])).code).toBe(0);

    for (const directory of ["coverage", path.join("node_modules/@verixa/sessions/coverage")]) {
      await expect(lstat(path.join(root, directory))).rejects.toThrow();
    }
  });

  it("counts coverage by the files it held, so the log is not a lie about size", async () => {
    const root = await makeBundle(coverage);

    const { stdout } = await prune([root]);

    expect(stdout).toContain("pruned 3 coverage/ file(s)");
    expect(stdout).toContain("pruned 2 entry(s)");
  });

  it("does not reach into third-party packages", async () => {
    const root = await makeBundle([...theirs, ...ours]);

    expect((await prune([root])).code).toBe(0);

    for (const file of theirs) {
      await expect(readFile(path.join(root, file), "utf8")).resolves.toContain(file);
    }

    for (const file of ours) {
      await expect(readFile(path.join(root, file), "utf8")).rejects.toThrow();
    }
  });
});
