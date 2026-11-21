import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateReleaseConfig } from "../../infra/ci/check-release-config.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("release automation configuration (Issues #481, #482, #483)", () => {
  it("validates the checked-in repository release configuration", () => {
    const errors = validateReleaseConfig(REPO_ROOT);
    expect(errors).toEqual([]);
  });

  it("detects out-of-order semantic-release plugins and missing release artifacts", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verixa-release-test-"));
    tempDirs.push(tmp);

    fs.writeFileSync(
      path.join(tmp, ".releaserc.json"),
      JSON.stringify({
        plugins: [
          "@semantic-release/github",
          "@semantic-release/commit-analyzer",
          "@semantic-release/release-notes-generator",
          "@semantic-release/changelog",
          "@semantic-release/git",
        ],
      }),
    );
    fs.writeFileSync(path.join(tmp, "CHANGELOG.md"), "# Changelog\n");
    fs.mkdirSync(path.join(tmp, ".changeset"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".changeset", "config.json"),
      JSON.stringify({ access: "public", baseBranch: "main", fixed: [], ignore: [] }),
    );

    const errors = validateReleaseConfig(tmp);
    expect(errors.some((e) => e.includes("out of order"))).toBe(true);
    expect(errors.some((e) => e.includes("sbom/verixa.cdx.json"))).toBe(true);
    expect(errors.some((e) => e.includes("docker-image-digest.txt"))).toBe(true);
  });

  it("rejects publishable packages missing provenance or marked private", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verixa-pkg-test-"));
    tempDirs.push(tmp);

    fs.copyFileSync(path.join(REPO_ROOT, ".releaserc.json"), path.join(tmp, ".releaserc.json"));
    fs.copyFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), path.join(tmp, "CHANGELOG.md"));
    fs.mkdirSync(path.join(tmp, ".changeset"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, ".changeset", "config.json"),
      path.join(tmp, ".changeset", "config.json"),
    );

    const pkgDir = path.join(tmp, "packages", "rate-limiting");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@verixa/rate-limiting",
        version: "0.1.0",
        private: true,
      }),
    );

    const errors = validateReleaseConfig(tmp);
    expect(errors.some((e) => e.includes('must not have "private": true'))).toBe(true);
    expect(errors.some((e) => e.includes("provenance"))).toBe(true);
  });
});
