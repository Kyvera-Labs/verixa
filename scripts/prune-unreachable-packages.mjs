#!/usr/bin/env node
/**
 * Removes every package in a `pnpm deploy` bundle that the app can only reach through an excluded
 * package (by default the `prisma` CLI, `typescript` and `@types/*`).
 *
 * `@prisma/client` declares the CLI and TypeScript as optional peers, so `pnpm deploy --prod`
 * installs them, and the Prisma 7 CLI brings a large tree of its own. Instead of naming packages,
 * this walks the bundle the way Node resolves it, from the app's `node_modules` through pnpm's
 * sibling dependency links, never entering an excluded package. Unreached store entries and
 * dangling links are deleted.
 *
 * Runs before the Dockerfile's load proof, so anything the app needed fails the build there.
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
