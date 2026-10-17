#!/usr/bin/env node
/**
 * Strip everything a running Node process will never read out of a deployed
 * bundle (roadmap Issue 216).
 *
 * Two different things end up in `/out` that should not ship:
 *
 * 1. **Build residue.** `pnpm deploy --prod` leaves dev *dependencies* behind,
 *    but TypeScript still emits `<file>.js.map` and `<file>.d.ts.map` beside
 *    every compiled file, and every suite compiles to `<name>.spec.js`. A
 *    `.js.map` is the original source, and a `.spec.js` is a worked description
 *    of every assumption an attacker could make about the code.
 * 2. **Our own sources and test output.** No workspace package declares a
 *    `files` array, so `pnpm deploy` copies each package directory whole:
 *    `apps/api/src/*.ts`, every package's `index.ts`, `domain/`,
 *    `application/`, and whatever `coverage/` the test run left behind.
 *
 * Third-party `.ts` files are deliberately *not* touched. They are published
 * artefacts of other projects, some of which resolve through them, and this
 * script's job is to remove what Verixa's own build put there — not to guess
 * about someone else's package layout.
 *
 * The step runs *before* the Dockerfile's load proof on purpose. If anything in
 * the bundle did need a file removed here, the build fails at that line with a
 * module resolution error rather than at 03:00 as a crashed pod.
 *
 * Usage: node scripts/prune-runtime-bundle.mjs <directory>
 */

import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Suffixes, not globs, because the names are machine-generated and fixed. Note
 * that `*.d.ts.map` ends in `.map`, so no entry below can swallow another one.
 */
const PRUNED_SUFFIXES = [".js.map", ".d.ts.map", ".d.ts", ".spec.js"];

/**
 * Directories removed wholesale, by name, wherever they appear.
 */
const PRUNED_DIRECTORIES = ["coverage"];

/**
 * The scope every workspace package lives under, including the app itself.
 * Nothing third-party carries it, which is what makes the name a safe test for
 * "this file is ours".
 */
const WORKSPACE_SCOPE = "@verixa";

const WORKSPACE_SOURCE_CATEGORY = ".ts (workspace source)";

function suffixCategoryOf(name) {
  return PRUNED_SUFFIXES.find((suffix) => name.endsWith(suffix));
}

/**
 * Is this path inside a package Verixa's own repository owns?
 *
 * Anything above the bundle's `node_modules` is the deployed app itself. Below
 * it, only `@verixa/*` is ours — and inside `.pnpm`, a workspace dependency
 * appears as `@verixa/<name>` again, so the same test covers both layouts.
 */
function isWorkspaceSource(relativePath) {
  const segments = relativePath.split(path.sep);
  return !segments.includes("node_modules") || segments.includes(WORKSPACE_SCOPE);
}

function categoryOf(name, relativePath) {
  const suffix = suffixCategoryOf(name);
  if (suffix !== undefined) {
    return suffix;
  }

  if (name.endsWith(".ts") && isWorkspaceSource(relativePath)) {
    return WORKSPACE_SOURCE_CATEGORY;
  }

  return undefined;
}

async function sizeOf(target) {
  // `withFileTypes` does not carry a size, and the MiB figure printed at the end
  // is quoted in the hardening doc, so it has to be the real one.
  return (await lstat(target)).size;
}

/**
 * Byte and file totals for a directory that is being deleted as a unit. The
 * count is reported so the build log says how much went, not just how many
 * top-level things did.
 */
async function tallyDirectory(dir) {
  let files = 0;
  let bytes = 0;

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const target = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await tallyDirectory(target);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }

    files += 1;
    bytes += await sizeOf(target);
  }

  return { files, bytes };
}

/**
 * Walk `dir` from `root`, returning what should go.
 *
 * Symlinks are never followed. A `pnpm deploy` output is meant to be
 * self-contained, but pnpm's store is made of links, and following them would
 * either count the same file several times or delete through a path that points
 * outside the bundle — which is exactly the kind of recursive delete that has to
 * be boring rather than clever.
 */
async function collect(dir, root) {
  const files = [];
  const directories = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const target = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (PRUNED_DIRECTORIES.includes(entry.name)) {
        const tally = await tallyDirectory(target);
        directories.push({ path: target, category: `${entry.name}/`, ...tally });
        continue;
      }

      const nested = await collect(target, root);
      files.push(...nested.files);
      directories.push(...nested.directories);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const category = categoryOf(entry.name, path.relative(root, target));

    if (category !== undefined) {
      files.push({ path: target, category, bytes: await sizeOf(target) });
    }
  }

  return { files, directories };
}

async function main() {
  const target = process.argv[2];

  if (target === undefined || target === "") {
    process.stderr.write("usage: prune-runtime-bundle.mjs <directory>\n");
    process.exitCode = 2;
    return;
  }

  const stats = await lstat(target).catch(() => undefined);

  if (stats === undefined || !stats.isDirectory()) {
    process.stderr.write(`prune-runtime-bundle: ${target} is not a directory\n`);
    process.exitCode = 1;
    return;
  }

  const { files, directories } = await collect(target, target);
  const megabytes = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

  const tally = new Map();

  for (const file of files) {
    const entry = tally.get(file.category) ?? { files: 0, bytes: 0 };
    tally.set(file.category, { files: entry.files + 1, bytes: entry.bytes + file.bytes });
  }

  for (const directory of directories) {
    const entry = tally.get(directory.category) ?? { files: 0, bytes: 0 };
    tally.set(directory.category, {
      files: entry.files + directory.files,
      bytes: entry.bytes + directory.bytes,
    });
  }

  for (const file of files) {
    await rm(file.path);
  }

  for (const directory of directories) {
    await rm(directory.path, { recursive: true });
  }

  const removed = files.length + directories.length;
  const fileBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const directoryBytes = directories.reduce((sum, directory) => sum + directory.bytes, 0);

  // Printed per category as well as in total: the container-hardening doc names
  // these counts, and a build log that says what went is the only review of
  // whether the step did something reasonable.
  for (const [category, entry] of [...tally].sort((a, b) => b[1].files - a[1].files)) {
    process.stdout.write(
      `pruned ${String(entry.files)} ${category} file(s), ${megabytes(entry.bytes)} MiB\n`,
    );
  }

  process.stdout.write(
    `pruned ${String(removed)} entry(s), ` +
      `${megabytes(fileBytes + directoryBytes)} MiB from ${target}\n`,
  );
}

await main();
