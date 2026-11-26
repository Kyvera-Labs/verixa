#!/usr/bin/env node
/**
 * Remove every package in a `pnpm deploy` bundle that the app cannot reach
 * without going through an excluded package (by default the `prisma` CLI,
 * `typescript` and `@types/*`).
 *
 * `@prisma/client` declares both as optional peers, and the lockfile resolves
 * them, so `pnpm deploy --prod` installs them into the bundle. Neither is read
 * at runtime: the client loads only the generated `.prisma` output. Deleting
 * the two package directories by name was enough for Prisma 6, whose CLI had a
 * handful of dependencies. The Prisma 7 CLI brings a much larger tree of its
 * own (Prisma Studio, React, charting libraries and their `@types/*`
 * packages), which stayed behind and failed CI's dev-dependency check.
 *
 * So instead of naming packages, this walks the bundle the way Node resolves
 * it. It starts from the app's own `node_modules` and follows each package's
 * dependency links (pnpm keeps them as siblings under
 * `.pnpm/<key>/node_modules`), never stepping into an excluded package. Store
 * entries the walk never reached are deleted, as are links left dangling.
 *
 * Runs before the Dockerfile's load proof, so if the app did need something
 * removed here, the image build fails there rather than in a running pod.
 *
 * Usage: node scripts/prune-unreachable-packages.mjs <bundle> [excluded-name...]
 */

import { lstatSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// `@types/*` holds only `.d.ts` declarations, which Node never loads; some
// runtime packages (e.g. @prisma/adapter-pg -> @types/pg) still list them as
// dependencies. An entry ending in `/*` excludes a whole scope.
const DEFAULT_EXCLUDED = ["prisma", "typescript", "@types/*"];

/** Package names in a node_modules directory, including `@scope/name`. */
function packageNames(nodeModulesDir) {
  let entries;
  try {
    entries = readdirSync(nodeModulesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      for (const scoped of readdirSync(path.join(nodeModulesDir, entry.name))) {
        names.push(`${entry.name}/${scoped}`);
      }
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * The `.pnpm` store entries reachable from the bundle root, and those that are
 * not. Pure apart from reading the file system, so the tests can call it.
 */
export function classifyStore(bundleRoot, excluded = DEFAULT_EXCLUDED) {
  const skip = new Set(excluded.filter((name) => !name.endsWith("/*")));
  const skipScopes = excluded
    .filter((name) => name.endsWith("/*"))
    .map((name) => name.slice(0, -1));
  const store = path.join(bundleRoot, "node_modules", ".pnpm");
  const storeReal = realpathSync(store);
  const reachedKeys = new Set();
  const scannedDirs = new Set();
  const pending = [];

  const follow = (nodeModulesDir, name) => {
    if (skip.has(name) || skipScopes.some((scope) => name.startsWith(scope))) return;
    let real;
    try {
      real = realpathSync(path.join(nodeModulesDir, name));
    } catch {
      return; // dangling link
    }
    const relative = path.relative(storeReal, real);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      const key = relative.split(path.sep)[0];
      if (!reachedKeys.has(key)) {
        reachedKeys.add(key);
        // A store entry's dependencies are its siblings.
        pending.push(path.join(storeReal, key, "node_modules"));
      }
    }
    // Some packages (injected workspace packages, nested installs) also
    // carry a node_modules of their own.
    pending.push(path.join(real, "node_modules"));
  };

  pending.push(path.join(bundleRoot, "node_modules"));
  while (pending.length > 0) {
    const dir = pending.pop();
    if (scannedDirs.has(dir)) continue;
    scannedDirs.add(dir);
    for (const name of packageNames(dir)) follow(dir, name);
  }

  const all = readdirSync(store, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => entry.name);
  return {
    reachable: all.filter((key) => reachedKeys.has(key)).sort(),
    unreachable: all.filter((key) => !reachedKeys.has(key)).sort(),
  };
}

/** Delete links (top-level and pnpm's hoisted ones) whose target is gone. */
function removeDanglingLinks(nodeModulesDir) {
  const removed = [];
  for (const name of packageNames(nodeModulesDir)) {
    const link = path.join(nodeModulesDir, name);
    if (!lstatSync(link).isSymbolicLink()) continue;
    try {
      statSync(link);
    } catch {
      unlinkSync(link);
      removed.push(name);
    }
  }
  return removed;
}

export function pruneUnreachable(bundleRoot, excluded = DEFAULT_EXCLUDED) {
  const { unreachable } = classifyStore(bundleRoot, excluded);
  const store = path.join(bundleRoot, "node_modules", ".pnpm");
  for (const key of unreachable) {
    rmSync(path.join(store, key), { recursive: true, force: true });
  }
  const dangling = [
    ...removeDanglingLinks(path.join(bundleRoot, "node_modules")),
    ...removeDanglingLinks(path.join(store, "node_modules")),
  ];
  return { removed: unreachable, dangling };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [bundle, ...excluded] = process.argv.slice(2);
  if (bundle === undefined) {
    console.error("usage: prune-unreachable-packages.mjs <bundle> [excluded-name...]");
    process.exit(2);
  }
  const { removed, dangling } = pruneUnreachable(
    bundle,
    excluded.length > 0 ? excluded : DEFAULT_EXCLUDED,
  );
  for (const key of removed) console.log(`removed ${key}`);
  console.log(
    `pruned ${removed.length} unreachable package(s) and ${dangling.length} dangling link(s)`,
  );
}
