/**
 * CycloneDX SBOM generator (Issue 215).
 *
 * The properties worth testing are the ones an auditor depends on: the document
 * says which spec version it is in, names every package the lockfile resolves
 * (including transitive ones, which is where supply-chain exposure actually
 * lives), claims completeness only when it means it, and refuses to produce a
 * document that fails schema validation.
 *
 * The last one is the interesting failure mode. A generator that writes a
 * malformed BOM looks like a release that was reviewed, and the person
 * downstream — running a scanner against the artifact — has no way to tell.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  FIXTURE_LOCKFILE,
  FIXTURE_ROOT_MANIFEST,
  FIXTURE_WIDGET_MANIFEST,
  FIXTURE_WORKSPACE_FILE,
  commitRepositoryFixture,
  createOutputDirectory,
  createRepositoryFixture,
  disposeRepositoryFixture,
  runSbomGenerator,
  runSbomGeneratorViaPnpmScript,
  type RepositoryFixture,
} from "./helpers/ci-tooling.js";

interface Component {
  readonly type: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly hashes?: readonly { readonly alg: string; readonly content: string }[];
  readonly properties?: readonly { readonly name: string; readonly value: string }[];
}

interface BillOfMaterials {
  readonly bomFormat: string;
  readonly specVersion: string;
  readonly serialNumber: string;
  readonly metadata: { readonly component: { readonly name: string; readonly version: string } };
  readonly components: readonly Component[];
  readonly dependencies: readonly { readonly ref: string; readonly dependsOn: readonly string[] }[];
  readonly compositions: readonly { readonly aggregate: string }[];
}

const created: RepositoryFixture[] = [];
const outputs: { directory: string; dispose(): void }[] = [];

/** A fresh path for generated output, cleaned up with the rest. */
function outputPath(): string {
  const created_ = createOutputDirectory();
  outputs.push(created_);
  return join(created_.directory, "bom.json");
}

function track(fixture: RepositoryFixture): RepositoryFixture {
  created.push(fixture);
  commitRepositoryFixture(fixture);
  return fixture;
}

/** A committed fixture workspace whose lockfile matches its manifests. */
function fixtureRepository(lockfile = FIXTURE_LOCKFILE): RepositoryFixture {
  return track(
    createRepositoryFixture({
      "package.json": FIXTURE_ROOT_MANIFEST,
      "pnpm-workspace.yaml": FIXTURE_WORKSPACE_FILE,
      "packages/widget/package.json": FIXTURE_WIDGET_MANIFEST,
      "pnpm-lock.yaml": lockfile,
    }),
  );
}

function generate(fixture: RepositoryFixture, output = outputPath()): BillOfMaterials {
  const result = runSbomGenerator(["--repo", fixture.directory, "--output", output]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(readFileSync(output, "utf8")) as BillOfMaterials;
}

function componentNamed(bom: BillOfMaterials, name: string): Component | undefined {
  return bom.components.find((component) => component.name === name);
}

afterAll(() => {
  for (const fixture of created) {
    disposeRepositoryFixture(fixture);
  }
  for (const output of outputs) {
    output.dispose();
  }
});

// Every case spawns the generator, so the clock is process launch plus an ajv
// schema compile rather than the work being tested. The suite-level timeout
// covers the cases that run it twice.
describe("generate-sbom", () => {
  it("describes a fixture workspace as a CycloneDX 1.6 document", () => {
    const bom = generate(fixtureRepository());

    expect(bom.bomFormat).toBe("CycloneDX");
    expect(bom.specVersion).toBe("1.6");
    expect(bom.metadata.component).toMatchObject({ name: "fixture-root", version: "0.1.0" });

    const purls = bom.components.map((component) => component.purl);
    // Direct *and* transitive. Leaving out the transitive closure is the common
    // way an SBOM ends up silent about the package that turns out to be
    // vulnerable. Order is not asserted here — that is the determinism test's
    // job — because the sort is a collation, and a collation is not portable.
    expect(purls).toHaveLength(4);
    expect(purls).toEqual(
      expect.arrayContaining([
        // A scoped name has to be percent-encoded in a purl or its path is wrong.
        "pkg:npm/%40fixture/widget@0.1.0",
        "pkg:npm/left-pad@1.3.0",
        "pkg:npm/right-pad@2.0.0",
        "pkg:npm/tiny-lru@11.0.1",
      ]),
    );

    // The integrity hash the lockfile recorded survives the round trip into
    // CycloneDX's hex form, which is what lets a consumer verify a tarball.
    expect(componentNamed(bom, "left-pad")?.hashes).toEqual([
      {
        alg: "SHA-512",
        content:
          "52b1666117820b264bc6d8e1893246ca966f6d5f345af154e927e7ad1c067ef133f96734" +
          "f0fda8721db62f223df66790e732cb5a26e32c744e26a6cb727c807d",
      },
    ]);
  });

  it("marks this repository's own packages as workspace components", () => {
    const bom = generate(fixtureRepository());

    expect(componentNamed(bom, "@fixture/widget")?.properties).toEqual([
      { name: "verixa:workspacePath", value: "packages/widget" },
    ]);
    // A registry package carries no such property, so the two are separable
    // downstream without anyone maintaining a list of internal names.
    expect(componentNamed(bom, "left-pad")?.properties).toBeUndefined();
  });

  it("links each package to what it depends on", () => {
    const bom = generate(fixtureRepository());
    const edges = new Map(bom.dependencies.map((entry) => [entry.ref, entry.dependsOn]));

    expect(edges.get("pkg:npm/fixture-root@0.1.0")).toEqual(["pkg:npm/left-pad@1.3.0"]);
    expect(edges.get("pkg:npm/left-pad@1.3.0")).toEqual(["pkg:npm/tiny-lru@11.0.1"]);
    expect(edges.get("pkg:npm/%40fixture/widget@0.1.0")).toEqual(["pkg:npm/right-pad@2.0.0"]);
  });

  it("claims completeness, and means it", () => {
    // `aggregate: complete` is the claim a scanner acts on. It is only honest
    // because the input is the lockfile — a complete set by construction —
    // rather than whatever an installed tree happened to look like.
    expect(generate(fixtureRepository()).compositions).toEqual([{ aggregate: "complete" }]);
  });

  it("produces the same inventory twice, and a different serial number each time", () => {
    const fixture = fixtureRepository();
    const first = generate(fixture);
    const second = generate(fixture, outputPath());

    expect(second.components).toEqual(first.components);
    expect(second.dependencies).toEqual(first.dependencies);
    // Deliberate, and documented in the generator: CycloneDX asks for a fresh
    // URN per document so two BOMs of one release can be diffed for equality
    // rather than for identity.
    expect(second.serialNumber).not.toBe(first.serialNumber);
    expect(second.serialNumber).toMatch(/^urn:uuid:/u);
  });

  it("validates the artifact it wrote, the way the release workflow re-checks it", () => {
    const output = outputPath();
    generate(fixtureRepository(), output);

    const result = runSbomGenerator(["--validate-only", output]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("validates against CycloneDX 1.6");
  });

  it("refuses to write a document that fails schema validation", () => {
    // A license that is a single token — so it passes the generator's own
    // "is this an SPDX identifier" heuristic — but is not in SPDX's list, which
    // is what the CycloneDX schema checks against.
    const fixture = track(
      createRepositoryFixture({
        "package.json": FIXTURE_ROOT_MANIFEST,
        "pnpm-workspace.yaml": FIXTURE_WORKSPACE_FILE,
        "packages/widget/package.json": FIXTURE_WIDGET_MANIFEST.replace(
          '"license": "MIT"',
          '"license": "MIT-Somemade"',
        ),
        "pnpm-lock.yaml": FIXTURE_LOCKFILE,
      }),
    );

    const output = outputPath();
    const result = runSbomGenerator(["--repo", fixture.directory, "--output", output]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not validate against CycloneDX 1.6");
    // Nothing is left on disk for downstream tooling to pick up.
    expect(() => readFileSync(output, "utf8")).toThrow();
  });

  it("fails rather than inventing a component for a resolution it cannot describe", () => {
    const fixture = fixtureRepository(
      FIXTURE_LOCKFILE.replace(
        // A hand-edited or truncated lockfile: a snapshot still edges to a
        // package the `packages:` block no longer describes.
        "  tiny-lru@11.0.1:\n    resolution: {integrity: sha512-tA9ywjkwQP3P0g9JM56b7hNjOZSzOeczBiRnJz6U46bKy9A5flDT1Yi+wnEz+0+O41ERndtPzdtWMLay8yu55w==}\n\n",
        "",
      ),
    );

    const result = runSbomGenerator(["--repo", fixture.directory, "--output", outputPath()]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("depends on tiny-lru@11.0.1, which has no packages: entry");
  });

  // The one test that shells through `pnpm run`, so it pays package-manager
  // startup on top of a tsx compile and a full-workspace parse: 17.5s warm on
  // this machine, and past vitest's 30s default while other workers are
  // competing for it. A subprocess assertion that fails because the box was
  // busy teaches nobody anything.
  it("builds and validates the real repository's SBOM", () => {
    const output = outputPath();
    const result = runSbomGeneratorViaPnpmScript(["--output", output]);

    expect(result.exitCode).toBe(0);

    // The real graph is where this generator's edge cases live: peer-suffixed
    // resolutions, aliased snapshot edges, and workspace members reached by
    // `link:` and `file:`. A fixture covering only the tidy shapes let all three
    // of those slip through while this was being written.
    const bom = JSON.parse(readFileSync(output, "utf8")) as BillOfMaterials;
    expect(bom.specVersion).toBe("1.6");
    expect(bom.compositions).toEqual([{ aggregate: "complete" }]);
    expect(bom.components.length).toBeGreaterThan(100);
    expect(componentNamed(bom, "fastify")).toBeDefined();
  }, 120_000);
}, 30_000);
