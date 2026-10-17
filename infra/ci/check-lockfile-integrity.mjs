#!/usr/bin/env node
/**
 * Lockfile integrity gate (Issue 215).
 *
 * Answers one question before anything else in CI is allowed to run: does
 * `pnpm-lock.yaml` describe exactly what the manifests declare, and is it
 * committed at all? If it does not, `--frozen-lockfile` fails with a
 * pnpm-internal resolution message, `--no-frozen` silently rewrites the
 * lockfile, and either way the build that follows is of a dependency graph
 * nobody reviewed.
 *
 * Why this exists when CI already runs `pnpm install --frozen-lockfile`:
 *
 * - `--frozen-lockfile` stops at the first mismatch it hits. This reports every
 *   mismatch across the workspace in one pass, naming the manifest file and the
 *   dependency.
 * - `--frozen-lockfile` says nothing about floating ranges (`*`, `latest`,
 *   `4.x`). A lockfile can satisfy one perfectly and still describe a graph
 *   that changes underneath a rebuild, because the next resolution of the same
 *   manifest is free to pick something newer. Rejecting floats at the manifest
 *   is the only point where that choice is still cheap to reverse.
 * - `--frozen-lockfile` says nothing about whether the lockfile is *committed*,
 *   which is check 3 below and the failure mode with the widest blast radius.
 *
 * Why plain JavaScript with no dependencies, when its sibling `generate-sbom.ts`
 * is TypeScript: this has to run *before* `pnpm install`, so it cannot be
 * installed — a missing `node_modules` is one of the states it exists to
 * diagnose. Same reason the lockfile reader below is hand-written for the shape
 * pnpm emits rather than a general YAML parser: it errors out on a shape it does
 * not recognise instead of guessing. A gate that cannot verify should fail, not
 * pass on a misread.
 *
 * Usage: node infra/ci/check-lockfile-integrity.mjs [--repo <path>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * The pnpm lockfile format this reader understands. A major bump has to be an
 * intentional edit here, so that upgrading pnpm forces a review of what this
 * gate actually checks rather than leaving it quietly reading the wrong shape.
 */
const SUPPORTED_LOCKFILE_MAJOR = "9";

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

class CheckFailure extends Error {}

/**
 * Is this range unbounded, i.e. resolvable to different versions over time?
 *
 * `workspace:*` and friends are exempt: they point at a package in this
 * repository, and the lockfile records the resolved link, so "floating" there
 * means "tracks this repo's own version", not "tracks whatever the registry
 * publishes next".
 */
function isFloatingSpecifier(specifier) {
  const range = specifier.trim();
  if (range === "") {
    return true;
  }
  if (range.startsWith("workspace:")) {
    return false;
  }
  // Anything with a protocol or alias prefix (`npm:`, `catalog:`, `file:`,
  // `git+ssh://`, `link:`) is not a version range; pnpm resolves those by
  // location, and inventing a grammar for them here would only produce
  // false confidence.
  if (range.includes(":")) {
    return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(range)) {
    // A bare word with no digits is a dist-tag (`latest`, `next`, `beta`),
    // which is a range that always moves.
    return true;
  }
  return /(?:^|[.\s-])(?:[xX]|\*)(?:$|[.\s-])/.test(range);
}

/**
 * Reads pnpm's lockfile text into `{ lockfileVersion, importers, packageKeys }`.
 *
 * `importers` maps a workspace-relative path (`.` for the root, `apps/api` for
 * a member, always forward-slash separated the way pnpm writes it) to each
 * dependency section, and each section to `{ specifier, version }` per package.
 * `packageKeys` is every key of the top-level `packages:` block — pnpm's record
 * of the resolved identity of everything that will actually be installed.
 *
 * The reader is a state machine over indentation, because pnpm emits one fixed
 * shape rather than arbitrary YAML:
 *
 *   lockfileVersion: '9.0'
 *   importers:
 *     <path>:
 *       <section>:
 *         <package>:
 *           specifier: <range>
 *           version: <resolved>
 *   packages:
 *     <package>@<resolved>:
 */
function readLockfile(text) {
  const lines = text.split(/\r?\n/u);
  const importers = new Map();
  const packageKeys = new Set();
  let lockfileVersion = null;

  let block = null; // "importers" | "packages" | "skip" | null
  let importer = null;
  let section = null;
  let dependency = null;

  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.replace(/\s+$/u, "");
    if (line === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const where = `pnpm-lock.yaml:${index + 1}`;

    if (indent === 0) {
      importer = null;
      section = null;
      dependency = null;
      if (content === "importers:") {
        block = "importers";
        continue;
      }
      if (content === "packages:") {
        block = "packages";
        continue;
      }
      if (content.endsWith(":")) {
        // settings:, overrides:, snapshots: — present but not needed here.
        block = "skip";
        continue;
      }
      const separator = content.indexOf(":");
      if (separator !== -1 && content.slice(0, separator) === "lockfileVersion") {
        block = null;
        lockfileVersion = unquote(content.slice(separator + 1).trim());
      } else {
        block = "skip";
      }
      continue;
    }

    if (block === "packages") {
      if (indent !== 2) {
        continue;
      }
      if (!content.endsWith(":")) {
        throw new CheckFailure(`${where}: unexpected entry in the packages block: "${content}"`);
      }
      packageKeys.add(unquote(content.slice(0, -1)));
      continue;
    }

    if (block !== "importers") {
      continue;
    }

    if (indent === 2) {
      if (content === "{}" && importer !== null) {
        continue;
      }
      if (!content.endsWith(":")) {
        throw new CheckFailure(`${where}: unexpected importer entry: "${content}"`);
      }
      importer = normalizeSlashes(unquote(content.slice(0, -1)));
      section = null;
      dependency = null;
      if (!importers.has(importer)) {
        importers.set(importer, new Map());
      }
      continue;
    }

    if (indent === 4) {
      if (!content.endsWith(":")) {
        throw new CheckFailure(
          `${where}: unexpected entry for importer "${importer}": "${content}"`,
        );
      }
      section = content.slice(0, -1);
      dependency = null;
      const sections = importers.get(importer);
      if (DEPENDENCY_SECTIONS.includes(section)) {
        sections.set(section, new Map());
      } else if (section !== "transitivePeerDependencies") {
        throw new CheckFailure(
          `${where}: unknown importer section "${section}" — this gate does not recognise that ` +
            "shape and will not guess at it",
        );
      }
      continue;
    }

    if (indent === 6) {
      if (section === "transitivePeerDependencies") {
        continue;
      }
      if (!content.endsWith(":")) {
        throw new CheckFailure(`${where}: unexpected entry under "${section}:": "${content}"`);
      }
      dependency = unquote(content.slice(0, -1));
      importers.get(importer).get(section).set(dependency, {});
      continue;
    }

    if (indent === 8) {
      const separator = content.indexOf(":");
      const field = separator === -1 ? "" : content.slice(0, separator);
      if (field !== "specifier" && field !== "version") {
        throw new CheckFailure(
          `${where}: unexpected field "${field}" on dependency "${dependency}" — this gate reads ` +
            "only specifier and version",
        );
      }
      importers.get(importer).get(section).get(dependency)[field] = unquote(
        content.slice(separator + 1).trim(),
      );
      continue;
    }

    throw new CheckFailure(`${where}: unrecognised indentation for "${content}"`);
  }

  return { lockfileVersion, importers, packageKeys };
}

function unquote(value) {
  return value.replace(/^'([\s\S]*)'$/u, "$1").replace(/^"([\s\S]*)"$/u, "$1");
}

/**
 * Drops pnpm's peer-dependency suffix from a resolved version.
 *
 * `vitest@3.2.7(@types/node@22.20.4)` and `vitest@3.2.7` are the same bytes on
 * disk — the suffix records which peer *combination* a resolution graph used, so
 * it appears in the `snapshots:` block, which describes those graphs. The
 * `packages:` block, which is where the integrity check looks for a package that
 * will actually be installed, lists each `name@version` once without it.
 */
function stripPeerSuffix(resolved) {
  let end = resolved.length;
  while (end > 0 && resolved[end - 1] === ")") {
    let depth = 0;
    let start = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (resolved[index] === ")") {
        depth += 1;
      } else if (resolved[index] === "(") {
        depth -= 1;
        if (depth === 0) {
          start = index;
          break;
        }
      }
    }
    if (start === -1) {
      // Unbalanced parentheses: not a peer suffix, and not something to guess
      // about — return what was given and let the packages: lookup report it.
      return resolved;
    }
    end = start;
  }
  return resolved.slice(0, end);
}

function normalizeSlashes(value) {
  return value.split(path.sep).join("/");
}

/**
 * The workspace's package directories, from `pnpm-workspace.yaml`.
 *
 * Only the two shapes this repository uses are handled: a literal path and a
 * single-level `dir/*` glob. A recursive glob, pnpm 10's mapping form of
 * `packages:`, or any other list syntax is an error rather than a partial read
 * — a gate that silently checks half the workspace is worse than one that fails.
 */
function readWorkspacePackages(repoRoot) {
  const file = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!existsSync(file)) {
    throw new CheckFailure("pnpm-workspace.yaml is missing — every pnpm workspace needs one");
  }
  const where = "pnpm-workspace.yaml";
  const patterns = [];
  let inPackages = false;

  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const topLevel = rawLine.length === rawLine.trimStart().length;
    if (topLevel) {
      inPackages = line === "packages:";
      if (line.startsWith("packages:") && line !== "packages:") {
        throw new CheckFailure(
          `${where}: "${line}" — the lockfile gate reads only a block-style packages list`,
        );
      }
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (!line.startsWith("- ")) {
      throw new CheckFailure(`${where}: expected a packages list item, found "${line}"`);
    }
    patterns.push(unquote(line.slice(2).trim()));
  }

  const names = [];
  for (const pattern of patterns) {
    if (pattern.includes("**")) {
      throw new CheckFailure(`${where}: recursive glob "${pattern}" is not supported here`);
    }
    if (!pattern.endsWith("/*")) {
      names.push(pattern);
      continue;
    }
    const parent = pattern.slice(0, -2);
    const parentPath = path.join(repoRoot, parent);
    if (!existsSync(parentPath)) {
      continue;
    }
    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(parentPath, entry.name, "package.json"))) {
        names.push(`${parent}/${entry.name}`);
      }
    }
  }
  return names;
}

/**
 * The lockfile must be committed, not merely present on disk.
 *
 * An untracked `pnpm-lock.yaml` installs fine locally and then does not exist in
 * CI, where pnpm resolves the manifests from scratch — a graph nobody reviewed,
 * on every build, with the tests passing throughout. Whether the file is tracked
 * is the only question that separates those two states.
 */
function assertLockfileIsCommitted(repoRoot) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "pnpm-lock.yaml"], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    const detail = (error.stderr ?? "").toString().trim();
    if (detail.includes("did not match any file")) {
      throw new CheckFailure(
        "pnpm-lock.yaml exists but is not tracked by git, so CI would never see it. Commit it.",
      );
    }
    throw new CheckFailure(
      `could not ask git whether pnpm-lock.yaml is tracked${detail === "" ? ` (${error.message})` : ` (${detail})`} — ` +
        "this gate fails rather than skipping, because a build whose lockfile provenance is unknown " +
        "is exactly what it is here to prevent.",
    );
  }
}

function readManifest(repoRoot, relativePath) {
  const file = path.join(repoRoot, relativePath);
  if (!existsSync(file)) {
    throw new CheckFailure(
      `${relativePath}: listed in pnpm-workspace.yaml but has no package.json`,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CheckFailure(`${relativePath}: cannot parse (${error.message})`);
  }
}

function declaredDependencies(manifest, manifestPath, problems) {
  const declared = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      declared.set(`${section}\u0000${name}`, specifier);
      if (isFloatingSpecifier(specifier)) {
        problems.push(
          `${manifestPath}: ${section}["${name}"] is "${specifier}" — a floating range resolves to ` +
            "whatever the registry serves at install time, so the lockfile stops being a record of " +
            "what was tested",
        );
      }
    }
  }
  return declared;
}

function checkImporter(importer, manifestPath, declared, lock, problems) {
  if (importer === undefined) {
    problems.push(
      `pnpm-lock.yaml: ${manifestPath} is a workspace package with no importer entry — the lockfile ` +
        "does not know it exists. Run pnpm install.",
    );
    return;
  }

  const locked = new Map();
  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, entry] of importer.get(section) ?? new Map()) {
      locked.set(`${section}\u0000${name}`, entry);
    }
  }

  for (const [key, specifier] of declared) {
    const [, name] = key.split("\u0000");
    const entry = locked.get(key);
    if (entry === undefined) {
      problems.push(
        `pnpm-lock.yaml: ${manifestPath} declares ${name}@${specifier}, which the lockfile does not ` +
          "list — the manifest changed without pnpm install being run",
      );
      continue;
    }
    if (entry.specifier !== specifier) {
      problems.push(
        `pnpm-lock.yaml: ${manifestPath} ${name}: the manifest says "${specifier}" and the lockfile ` +
          `recorded "${entry.specifier}" — the lockfile is stale`,
      );
    }
    // `link:` entries are workspace siblings and never appear in `packages:`;
    // everything else has to, or the lockfile describes an install that cannot
    // be performed.
    const resolved = entry.version;
    if (typeof resolved === "string" && !resolved.startsWith("link:")) {
      const packageKey = `${name}@${stripPeerSuffix(resolved)}`;
      if (!lock.packageKeys.has(packageKey)) {
        problems.push(
          `pnpm-lock.yaml: ${manifestPath} resolves ${name} to ${resolved}, which has no packages: ` +
            "entry — the lockfile is truncated or was hand-edited",
        );
      }
    }
  }

  for (const [key] of locked) {
    if (declared.has(key)) {
      continue;
    }
    const [, name] = key.split("\u0000");
    problems.push(
      `pnpm-lock.yaml: ${manifestPath} still locks ${name}, which is no longer in the manifest — a ` +
        "dependency was removed without pnpm install being run",
    );
  }
}

function checkRepository(repoRoot) {
  const problems = [];

  if (!existsSync(path.join(repoRoot, "pnpm-lock.yaml"))) {
    // Not a warning: an absent lockfile is how a floating install begins. pnpm
    // will happily resolve and write one; CI must not.
    throw new CheckFailure(
      "pnpm-lock.yaml is missing. Commit it — CI has to install a reviewed graph rather than resolve " +
        "a fresh one on every build.",
    );
  }
  assertLockfileIsCommitted(repoRoot);

  const lock = readLockfile(readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"));

  if (lock.lockfileVersion === null) {
    throw new CheckFailure("pnpm-lock.yaml has no lockfileVersion — is that a pnpm lockfile?");
  }
  if (!lock.lockfileVersion.startsWith(`${SUPPORTED_LOCKFILE_MAJOR}.`)) {
    throw new CheckFailure(
      `pnpm-lock.yaml is lockfileVersion ${lock.lockfileVersion}, which this gate does not understand ` +
        `(it reads ${SUPPORTED_LOCKFILE_MAJOR}.x). Review and update ` +
        "infra/ci/check-lockfile-integrity.mjs rather than letting it read the wrong shape.",
    );
  }

  const manifests = [
    { dir: ".", manifestPath: "package.json", manifest: readManifest(repoRoot, "package.json") },
    ...readWorkspacePackages(repoRoot).map((dir) => ({
      dir,
      manifestPath: `${dir}/package.json`,
      manifest: readManifest(repoRoot, dir + "/package.json"),
    })),
  ];

  const workspaceDirs = new Set(manifests.map(({ dir }) => dir));
  for (const importerDir of lock.importers.keys()) {
    if (!workspaceDirs.has(importerDir)) {
      problems.push(
        `pnpm-lock.yaml: importer "${importerDir}" matches no workspace package — a package was ` +
          "removed from pnpm-workspace.yaml without pnpm install being run",
      );
    }
  }

  for (const { dir, manifestPath, manifest } of manifests) {
    const declared = declaredDependencies(manifest, manifestPath, problems);
    checkImporter(lock.importers.get(dir), manifestPath, declared, lock, problems);
  }

  return { problems, packageCount: lock.packageKeys.size, workspaceCount: manifests.length };
}

function main(argv) {
  const repoRoot = path.resolve(cliFlag(argv, "--repo") ?? process.cwd());

  const { problems, packageCount, workspaceCount } = checkRepository(repoRoot);

  if (problems.length > 0) {
    for (const problem of problems) {
      process.stderr.write(`lockfile integrity: ${problem}\n`);
    }
    process.stderr.write(
      `\nlockfile integrity: ${problems.length} problem(s). Usually fixed by running pnpm install ` +
        "and committing the resulting pnpm-lock.yaml.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `lockfile integrity: ok — ${workspaceCount} workspace package(s), ${packageCount} locked package(s)\n`,
  );
}

function cliFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CheckFailure) {
    process.stderr.write(`lockfile integrity: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
