import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { classifyStore, pruneUnreachable } from "../../scripts/prune-unreachable-packages.mjs";

/**
 * The step the API image build runs after `pnpm deploy` to drop the Prisma
 * CLI's dependency tree (and other optional peers) from the bundle.
 *
 * Each test builds a miniature pnpm layout: store entries under
 * `node_modules/.pnpm/<key>/node_modules/<name>`, dependency links as siblings,
 * top-level links for the app's direct dependencies and pnpm's hoisted links.
 * Links are directory junctions so the suite also runs on Windows without
 * symlink privileges. The real image is covered by the `docker` CI job.
 */

const run = promisify(execFile);
const script = fileURLToPath(
  new URL("../../scripts/prune-unreachable-packages.mjs", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function link(target: string, at: string): void {
  mkdirSync(path.dirname(at), { recursive: true });
  symlinkSync(target, at, "junction");
}

/** Creates store entry `key` for package `name` and returns its directory. */
function storePackage(root: string, key: string, name: string): string {
  const dir = path.join(root, "node_modules", ".pnpm", key, "node_modules", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  return dir;
}

/** Links dependency `dep` (at `depDir`) into store entry `key`'s node_modules. */
function dependOn(root: string, key: string, dep: string, depDir: string): void {
  link(depDir, path.join(root, "node_modules", ".pnpm", key, "node_modules", dep));
}

/**
 * app -> app-dep -> shared, app-dep -> @types/pg, app-dep -> prisma (optional
 * peer) -> studio -> shared, plus an orphan nothing points at.
 */
function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "prune-unreachable-"));
  roots.push(root);

  const appDep = storePackage(root, "app-dep@1.0.0", "app-dep");
  const shared = storePackage(root, "shared@1.0.0", "shared");
  const prisma = storePackage(root, "prisma@7.9.0", "prisma");
  const studio = storePackage(root, "studio@1.0.0", "studio");
  const typesPg = storePackage(root, "@types+pg@8.0.0", "@types/pg");
  storePackage(root, "orphan@1.0.0", "orphan");

  dependOn(root, "app-dep@1.0.0", "shared", shared);
  dependOn(root, "app-dep@1.0.0", "@types/pg", typesPg);
  dependOn(root, "app-dep@1.0.0", "prisma", prisma);
  dependOn(root, "prisma@7.9.0", "studio", studio);
  dependOn(root, "studio@1.0.0", "shared", shared);

  // What `pnpm deploy` leaves at the top level and in the hoisted directory.
  link(appDep, path.join(root, "node_modules", "app-dep"));
  link(prisma, path.join(root, "node_modules", "prisma"));
  link(studio, path.join(root, "node_modules", ".pnpm", "node_modules", "studio"));
  return root;
}

describe("prune-unreachable-packages", () => {
  it("keeps what the app reaches and drops what only the excluded CLI reaches", () => {
    const root = fixture();

    expect(classifyStore(root)).toEqual({
      reachable: ["app-dep@1.0.0", "shared@1.0.0"],
      unreachable: ["@types+pg@8.0.0", "orphan@1.0.0", "prisma@7.9.0", "studio@1.0.0"],
    });
  });

  it("deletes the unreachable store entries and the links left dangling", () => {
    const root = fixture();
    const store = path.join(root, "node_modules", ".pnpm");

    const result = pruneUnreachable(root);

    expect(result.removed).toHaveLength(4);
    expect(existsSync(path.join(store, "prisma@7.9.0"))).toBe(false);
    expect(existsSync(path.join(store, "studio@1.0.0"))).toBe(false);
    expect(existsSync(path.join(store, "shared@1.0.0"))).toBe(true);
    expect(existsSync(path.join(root, "node_modules", "app-dep", "package.json"))).toBe(true);
    expect(result.dangling.sort()).toEqual(["prisma", "studio"]);
  });

  it("keeps a package the app reaches directly even if it is also an excluded name's dependency", () => {
    const root = fixture();
    // The app itself now depends on studio too.
    link(
      path.join(root, "node_modules", ".pnpm", "studio@1.0.0", "node_modules", "studio"),
      path.join(root, "node_modules", "studio"),
    );

    expect(classifyStore(root).reachable).toContain("studio@1.0.0");
  });

  it("honours an explicit exclusion list from the command line", async () => {
    const root = fixture();

    const { stdout } = await run(process.execPath, [script, root, "shared"]);

    // Only `shared` is excluded now, so prisma, studio and @types/pg are kept
    // (reached through app-dep) and shared, reached only by name, goes.
    expect(stdout).toContain("removed shared@1.0.0");
    expect(stdout).toContain("removed orphan@1.0.0");
    expect(stdout).not.toContain("removed prisma@7.9.0");
    expect(existsSync(path.join(root, "node_modules", ".pnpm", "prisma@7.9.0"))).toBe(true);
  });
});
