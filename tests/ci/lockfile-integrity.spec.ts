/**
 * Lockfile integrity gate (Issue 215).
 *
 * The acceptance criterion is "CI fails if the lockfile is out of sync with the
 * manifests", and out of sync has several shapes: a dependency added, one
 * removed, a range changed, a resolution missing from the lockfile, a package
 * dropped from the workspace, a range that never pinned anything, and — the one
 * with the widest blast radius — a lockfile that is not in git at all, so CI
 * installs something nobody reviewed.
 *
 * Each case asserts on the message as well as the exit code. A gate whose
 * failure nobody can interpret gets bypassed, and the whole argument for this
 * one over `pnpm install --frozen-lockfile` is that it says which manifest,
 * which dependency, and what to run.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  FIXTURE_LOCKFILE,
  FIXTURE_ROOT_MANIFEST,
  FIXTURE_WIDGET_MANIFEST,
  commitRepositoryFixture,
  createRepositoryFixture,
  disposeRepositoryFixture,
  runLockfileGate,
  runLockfileGateViaPnpmScript,
  syncedRepositoryFixtureFiles,
  writeFixtureFile,
  withDependencies,
  type RepositoryFixture,
} from "./helpers/ci-tooling.js";

const created: RepositoryFixture[] = [];

/** A committed fixture in the synced state, with any file replaced. */
function trackedFixture(replacements: Readonly<Record<string, string>> = {}): RepositoryFixture {
  const fixture = createRepositoryFixture({ ...syncedRepositoryFixtureFiles(), ...replacements });
  created.push(fixture);
  commitRepositoryFixture(fixture);
  return fixture;
}

/** A committed fixture that contains no `pnpm-lock.yaml`. */
function fixtureWithoutCommittedLockfile(): RepositoryFixture {
  const files = syncedRepositoryFixtureFiles();
  delete files["pnpm-lock.yaml"];
  const fixture = createRepositoryFixture(files);
  created.push(fixture);
  commitRepositoryFixture(fixture);
  return fixture;
}

/** Applies a change to the lockfile's recorded specifier for `left-pad`. */
function withLockedSpecifier(text: string, specifier: string): string {
  return text.replace("specifier: ^1.3.0", `specifier: ${specifier}`);
}

afterAll(() => {
  for (const fixture of created) {
    disposeRepositoryFixture(fixture);
  }
});

// Each case commits a fixture and runs the gate as a subprocess, so the default
// 5s is spent on `git` and Node startup rather than on the check itself.
describe("check-lockfile-integrity", () => {
  it("accepts a lockfile that matches every manifest in the workspace", () => {
    const result = runLockfileGate(trackedFixture().directory);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // The counts are asserted rather than merely "ok", because a gate that read
    // one importer out of two and reported success would also print "ok".
    expect(result.stdout.trim()).toBe(
      "lockfile integrity: ok — 2 workspace package(s), 3 locked package(s)",
    );
  });

  it("names the dependency when a manifest gained one the lockfile never saw", () => {
    const result = runLockfileGate(
      trackedFixture({
        "package.json": withDependencies(FIXTURE_ROOT_MANIFEST, {
          "left-pad": "^1.3.0",
          "new-thing": "^9.1.0",
        }),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "pnpm-lock.yaml: package.json declares new-thing@^9.1.0, which the lockfile does not list",
    );
  });

  it("says which side is stale when a recorded specifier no longer matches", () => {
    const result = runLockfileGate(
      trackedFixture({
        // What a forgotten `pnpm install` after a range bump actually looks like.
        "pnpm-lock.yaml": withLockedSpecifier(FIXTURE_LOCKFILE, "^1.4.0"),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('left-pad: the manifest says "^1.3.0"');
    expect(result.stderr).toContain('the lockfile recorded "^1.4.0" — the lockfile is stale');
  });

  it("reports a dependency that was removed from the manifest but is still locked", () => {
    const result = runLockfileGate(
      trackedFixture({
        "packages/widget/package.json": withDependencies(FIXTURE_WIDGET_MANIFEST, {}),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "packages/widget/package.json still locks right-pad, which is no longer in the manifest",
    );
  });

  it("reports a workspace member the lockfile does not know about", () => {
    const result = runLockfileGate(
      trackedFixture({
        // The member package is still on disk; it just left the workspace.
        "pnpm-workspace.yaml": "packages:\n",
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('importer "packages/widget" matches no workspace package');
  });

  it("rejects a floating range, which no lockfile can pin down", () => {
    const result = runLockfileGate(
      trackedFixture({
        "package.json": withDependencies(FIXTURE_ROOT_MANIFEST, { "left-pad": "*" }),
        // Synced with the floating manifest on purpose: `--frozen-lockfile` is
        // satisfied by this lockfile, which is exactly the gap this gate closes.
        "pnpm-lock.yaml": withLockedSpecifier(FIXTURE_LOCKFILE, "*"),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('dependencies["left-pad"] is "*" — a floating range');
  });

  it("rejects a lockfile that records a resolution it cannot describe", () => {
    const result = runLockfileGate(
      trackedFixture({
        "pnpm-lock.yaml": FIXTURE_LOCKFILE.replace(
          // A hand-edited or truncated lockfile: the importer still points at
          // a package the lockfile no longer knows how to install.
          "  right-pad@2.0.0:\n    resolution: {integrity: sha512-ml5I5VSYlpbldC2fhOvKMakWBuCy5nu2KngOJj3eJhXx4hw2UznzyGAyRRWx8bY0KkKKpQGcnAt8VcrkfpZAHQ==}\n\n",
          "",
        ),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("resolves right-pad to 2.0.0, which has no packages: entry");
  });

  it("fails when the lockfile exists but is not committed", () => {
    // The state with the widest blast radius: everything passes locally, and CI
    // silently installs a graph from scratch on every build.
    const fixture = fixtureWithoutCommittedLockfile();
    writeFixtureFile(fixture, "pnpm-lock.yaml", FIXTURE_LOCKFILE);

    const result = runLockfileGate(fixture.directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "pnpm-lock.yaml exists but is not tracked by git, so CI would never see it.",
    );
  });

  it("fails when there is no lockfile at all", () => {
    const result = runLockfileGate(fixtureWithoutCommittedLockfile().directory);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pnpm-lock.yaml is missing.");
  });

  it("refuses a lockfile format it was not written to read", () => {
    const result = runLockfileGate(
      trackedFixture({
        "pnpm-lock.yaml": FIXTURE_LOCKFILE.replace(
          "lockfileVersion: '9.0'",
          "lockfileVersion: '10.0'",
        ),
      }).directory,
    );

    expect(result.exitCode).toBe(1);
    // Not a silent pass on a misread: a pnpm upgrade has to come with a review
    // of what this gate checks.
    expect(result.stderr).toContain("which this gate does not understand (it reads 9.x)");
  });

  it("passes the real repository through the script CI and contributors run", () => {
    const result = runLockfileGateViaPnpmScript();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lockfile integrity: ok");
  });
}, 20_000);
