/**
 * Runs the Issue 215 CI tools as subprocesses, over throwaway repository
 * fixtures.
 *
 * Spawning rather than importing is the point. The deliverable is a command a
 * workflow invokes, so the tests have to exercise that command — including its
 * exit code and its stderr, which is the only thing a maintainer sees when the
 * gate fails. The SBOM generator additionally runs its CLI at module load and
 * calls `process.exit(1)` on failure, which an in-process test could not
 * survive.
 *
 * The root `package.json` scripts are mostly not used here (one test per tool
 * does use them, to keep the wiring honest). Going through `pnpm` for every
 * case would add a few seconds of package-manager startup per assertion and
 * make a pnpm failure indistinguishable from a tool failure.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** The repository these tools are written against. */
export const REPO_ROOT = join(moduleDirectory, "..", "..", "..");

const LOCKFILE_GATE = join(REPO_ROOT, "infra", "ci", "check-lockfile-integrity.mjs");
const MALWARE_INDICATOR_GATE = join(REPO_ROOT, "infra", "ci", "check-malware-indicators.mjs");
const SBOM_GENERATOR = join(REPO_ROOT, "infra", "ci", "generate-sbom.ts");
const DEPENDENCY_SCAN_GATE = join(REPO_ROOT, "infra", "ci", "dependency-scan.mjs");
const SECURITY_FIXTURE_CONFIG = join(
  REPO_ROOT,
  "infra",
  "ci",
  "lint-security-fixtures",
  "eslint.config.mjs",
);
const SECURITY_FIXTURE_DIRECTORY = "infra/ci/lint-security-fixtures";

/** Captured reports and manifests for the dependency-scan gate (Issue 207). */
export const DEPENDENCY_SCAN_FIXTURES = join(
  REPO_ROOT,
  "infra",
  "ci",
  "fixtures",
  "dependency-scan",
);

export function dependencyScanFixture(name: string): string {
  return join(DEPENDENCY_SCAN_FIXTURES, name);
}

/**
 * tsx's CLI, resolved by path instead of invoked by name.
 *
 * `pnpm exec tsx` would depend on a shell and on pnpm being on PATH; spawning
 * the CLI file with the current Node binary uses the version this repository
 * installed and behaves the same on every platform. Resolved from this file,
 * which is how the generator's own imports find the root's dev dependencies.
 */
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

export interface ToolResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], cwd: string): ToolResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    // Windows spawns `pnpm` through a .cmd shim, which needs a shell. Node and
    // the tsx CLI are real executables, so this only applies to the pnpm cases
    // — the same conditional the other shelling-out specs use.
    shell: process.platform === "win32" && command === "pnpm",
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** `node infra/ci/check-lockfile-integrity.mjs --repo <dir>` — the CI step's command. */
export function runLockfileGate(repositoryDirectory: string): ToolResult {
  return run(process.execPath, [LOCKFILE_GATE, "--repo", repositoryDirectory], REPO_ROOT);
}

/** `node infra/ci/check-malware-indicators.mjs --repo <dir>` — the CI step's command. */
export function runMalwareIndicatorGate(repositoryDirectory: string): ToolResult {
  return run(process.execPath, [MALWARE_INDICATOR_GATE, "--repo", repositoryDirectory], REPO_ROOT);
}

/** `pnpm run check:lockfile` at the repository root — the script developers and docs point at. */
export function runLockfileGateViaPnpmScript(): ToolResult {
  return run("pnpm", ["run", "check:lockfile"], REPO_ROOT);
}

/**
 * Runs ESLint against the deliberately vulnerable fixture snippets with the
 * fixture-only config (Issue 208).
 *
 * Spawning the CLI rather than importing ESLint's Node API keeps this test
 * free of a typed import for `eslint-plugin-security`, which ships no types —
 * and it is closer to what CI runs, which is the point of a lint gate test.
 */
export function runSecurityLintFixtureConfig(args: readonly string[]): ToolResult {
  return run(
    "pnpm",
    ["exec", "eslint", "--no-config-lookup", "--config", SECURITY_FIXTURE_CONFIG, ...args],
    REPO_ROOT,
  );
}

export const SECURITY_LINT_FIXTURES = SECURITY_FIXTURE_DIRECTORY;

/** `node infra/ci/dependency-scan.mjs <args>` — the Issue 207 gate step. */
export function runDependencyScan(args: readonly string[]): ToolResult {
  return run(process.execPath, [DEPENDENCY_SCAN_GATE, ...args], REPO_ROOT);
}

/** `tsx infra/ci/generate-sbom.ts <args>` */
export function runSbomGenerator(args: readonly string[]): ToolResult {
  return run(process.execPath, [TSX_CLI, SBOM_GENERATOR, ...args], REPO_ROOT);
}

/** `pnpm run sbom:generate <args>` — what `release.yml` calls. */
export function runSbomGeneratorViaPnpmScript(args: readonly string[]): ToolResult {
  return run("pnpm", ["run", "sbom:generate", ...args], REPO_ROOT);
}

/* ------------------------------------------------------------------ *
 * Repository fixtures
 *
 * A fixture is a directory of text files. Nothing is installed or built: both
 * tools read manifests and a lockfile, so a directory *is* the complete unit
 * of behaviour. The alternative — mutating the real repository to produce a
 * drifted lockfile — would be slow, and would leave the worktree dirty if an
 * assertion failed halfway through.
 * ------------------------------------------------------------------ */

export interface RepositoryFixture {
  readonly directory: string;
}

/** Creates a throwaway repository containing `files`, paths relative to its root. */
export function createRepositoryFixture(
  files: Readonly<Record<string, string>>,
): RepositoryFixture {
  const directory = mkdtempSync(join(tmpdir(), "verixa-ci-fixture-"));

  for (const [relativePath, text] of Object.entries(files)) {
    const target = join(directory, ...relativePath.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }

  return { directory };
}

/** Overwrites one file in a fixture — how each drift case is produced. */
export function writeFixtureFile(
  fixture: RepositoryFixture,
  relativePath: string,
  text: string,
): void {
  writeFileSync(join(fixture.directory, ...relativePath.split("/")), text, "utf8");
}

/**
 * Commits a fixture, so `git ls-files` answers the way it does in CI.
 *
 * The identity is passed per invocation rather than inherited from
 * configuration: a fixture has no user config to inherit, and a commit that
 * depends on the machine it happens to run on is a fixture that fails on
 * someone else's runner.
 */
export function commitRepositoryFixture(fixture: RepositoryFixture): void {
  const git = (args: readonly string[]): void => {
    const result = spawnSync("git", args, {
      cwd: fixture.directory,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr)}`);
    }
  };

  git(["init", "--quiet"]);
  git(["add", "--all"]);
  git([
    "-c",
    "user.name=Verixa CI Fixture",
    "-c",
    "user.email=ci-fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--message",
    "chore: commit lockfile fixture",
  ]);
}

export function disposeRepositoryFixture(fixture: RepositoryFixture): void {
  // Git writes pack and index files read-only on Windows, which makes the
  // first removal attempt fail intermittently.
  rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/**
 * A temporary directory for generated output, outside every fixture so a
 * generator's `mkdir -p` cannot be confused with the repository it reads.
 */
export function createOutputDirectory(): { readonly directory: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), "verixa-ci-output-"));
  return {
    directory,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/* ------------------------------------------------------------------ *
 * The fixture contents
 *
 * A minimal pnpm workspace in lockfileVersion 9.0: a root importing `left-pad`,
 * which pulls `tiny-lru` transitively, and one member package importing
 * `right-pad`. Each drift case below is one targeted string edit away from
 * this state, which is what makes the expected message obvious.
 *
 * The `integrity` values are genuine base64 SHA-512 digests rather than
 * placeholders: the SBOM generator turns them into CycloneDX `hashes`, whose
 * schema pins the hex length, so a fake digest would fail validation for a
 * reason that has nothing to do with the behaviour under test.
 * ------------------------------------------------------------------ */

export const FIXTURE_ROOT_MANIFEST = JSON.stringify(
  {
    name: "fixture-root",
    version: "0.1.0",
    private: true,
    license: "MIT",
    dependencies: { "left-pad": "^1.3.0" },
  },
  null,
  2,
);

export const FIXTURE_WIDGET_MANIFEST = JSON.stringify(
  {
    name: "@fixture/widget",
    version: "0.1.0",
    private: true,
    license: "MIT",
    dependencies: { "right-pad": "2.0.0" },
  },
  null,
  2,
);

export const FIXTURE_WORKSPACE_FILE = `packages:
  - "packages/*"
`;

export const FIXTURE_LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

  packages/widget:
    dependencies:
      right-pad:
        specifier: 2.0.0
        version: 2.0.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-UrFmYReCCyZLxtjhiTJGypZvbV80WvFU6SfnrRwGfvEz+Wc08P2och22LyI99meQ5zLLWibjLHROJqbLcnyAfQ==}

  right-pad@2.0.0:
    resolution: {integrity: sha512-ml5I5VSYlpbldC2fhOvKMakWBuCy5nu2KngOJj3eJhXx4hw2UznzyGAyRRWx8bY0KkKKpQGcnAt8VcrkfpZAHQ==}

  tiny-lru@11.0.1:
    resolution: {integrity: sha512-tA9ywjkwQP3P0g9JM56b7hNjOZSzOeczBiRnJz6U46bKy9A5flDT1Yi+wnEz+0+O41ERndtPzdtWMLay8yu55w==}

snapshots:

  left-pad@1.3.0:
    dependencies:
      tiny-lru: 11.0.1

  right-pad@2.0.0: {}

  tiny-lru@11.0.1: {}
`;

/** The synced fixture's files: manifests, workspace file, and a matching lockfile. */
export function syncedRepositoryFixtureFiles(): Record<string, string> {
  return {
    "package.json": FIXTURE_ROOT_MANIFEST,
    "pnpm-workspace.yaml": FIXTURE_WORKSPACE_FILE,
    "packages/widget/package.json": FIXTURE_WIDGET_MANIFEST,
    "pnpm-lock.yaml": FIXTURE_LOCKFILE,
  };
}

/**
 * A manifest with its `dependencies` replaced wholesale.
 *
 * Takes the manifest text rather than a name so a drift case reads as the edit
 * it is, and keeps the rest of the manifest — including `name`, which the SBOM
 * generator needs — intact.
 */
export function withDependencies(
  manifest: string,
  dependencies: Readonly<Record<string, string>>,
): string {
  const parsed = JSON.parse(manifest) as Record<string, unknown>;
  parsed["dependencies"] = dependencies;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}
