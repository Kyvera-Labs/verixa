#!/usr/bin/env node
/**
 * Validates Verixa's Phase 19 release automation configuration:
 * - `.releaserc.json` (semantic-release changelog + GitHub Release + artifacts)
 * - `CHANGELOG.md` (present with valid header)
 * - `.changeset/config.json` (independent per-package publishing)
 * - `packages/*\/package.json` (public access + npm provenance on publishable packages)
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} repoRoot
 * @returns {string[]} Validation errors (empty when valid).
 */
export function validateReleaseConfig(repoRoot) {
  const errors = [];

  // 1. Validate .releaserc.json
  const releasercPath = path.join(repoRoot, ".releaserc.json");
  if (!fs.existsSync(releasercPath)) {
    errors.push("Missing .releaserc.json at repository root.");
  } else {
    let rc;
    try {
      rc = JSON.parse(fs.readFileSync(releasercPath, "utf8"));
    } catch (err) {
      errors.push(`Invalid JSON in .releaserc.json: ${err.message}`);
      rc = null;
    }

    if (rc) {
      const plugins = Array.isArray(rc.plugins) ? rc.plugins : [];
      const pluginNames = plugins.map((p) => (Array.isArray(p) ? p[0] : p));
      const requiredOrder = [
        "@semantic-release/commit-analyzer",
        "@semantic-release/release-notes-generator",
        "@semantic-release/changelog",
        "@semantic-release/git",
        "@semantic-release/github",
      ];

      let lastIdx = -1;
      for (const name of requiredOrder) {
        const idx = pluginNames.indexOf(name);
        if (idx === -1) {
          errors.push(`.releaserc.json is missing required plugin "${name}".`);
        } else if (idx < lastIdx) {
          errors.push(
            `.releaserc.json plugin "${name}" is out of order (must follow earlier lifecycle plugins).`,
          );
        } else {
          lastIdx = idx;
        }
      }

      const githubPlugin = plugins.find(
        (p) => Array.isArray(p) && p[0] === "@semantic-release/github",
      );
      const assets = githubPlugin?.[1]?.assets;
      if (!Array.isArray(assets) || !assets.some((a) => a?.path === "sbom/verixa.cdx.json")) {
        errors.push("@semantic-release/github must attach sbom/verixa.cdx.json.");
      }
      if (
        !Array.isArray(assets) ||
        !assets.some((a) => a?.path === "release-artifacts/docker-image-digest.txt")
      ) {
        errors.push(
          "@semantic-release/github must attach release-artifacts/docker-image-digest.txt.",
        );
      }
    }
  }

  // 2. Validate CHANGELOG.md
  const changelogPath = path.join(repoRoot, "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    errors.push("Missing CHANGELOG.md at repository root.");
  } else {
    const content = fs.readFileSync(changelogPath, "utf8");
    if (!content.startsWith("# Changelog")) {
      errors.push('CHANGELOG.md must start with "# Changelog".');
    }
  }

  // 3. Validate .changeset/config.json
  const changesetConfigPath = path.join(repoRoot, ".changeset", "config.json");
  let ignoredPackages = new Set();
  if (!fs.existsSync(changesetConfigPath)) {
    errors.push("Missing .changeset/config.json.");
  } else {
    let cs;
    try {
      cs = JSON.parse(fs.readFileSync(changesetConfigPath, "utf8"));
    } catch (err) {
      errors.push(`Invalid JSON in .changeset/config.json: ${err.message}`);
      cs = null;
    }

    if (cs) {
      if (cs.access !== "public") {
        errors.push(`.changeset/config.json access must be "public", got "${String(cs.access)}".`);
      }
      if (cs.baseBranch !== "main") {
        errors.push(
          `.changeset/config.json baseBranch must be "main", got "${String(cs.baseBranch)}".`,
        );
      }
      if (Array.isArray(cs.fixed) && cs.fixed.length > 0) {
        errors.push(
          ".changeset/config.json must not use lockstep `fixed` groups; packages version independently.",
        );
      }
      ignoredPackages = new Set(Array.isArray(cs.ignore) ? cs.ignore : []);
    }
  }

  // 4. Validate packages/*/package.json publishability
  const packagesDir = path.join(repoRoot, "packages");
  if (fs.existsSync(packagesDir)) {
    for (const dir of fs.readdirSync(packagesDir)) {
      const pkgPath = path.join(packagesDir, dir, "package.json");
      if (!fs.existsSync(pkgPath)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (ignoredPackages.has(pkg.name)) {
        continue;
      }
      if (pkg.private === true) {
        errors.push(
          `Publishable package ${pkg.name} (packages/${dir}/package.json) must not have "private": true.`,
        );
      }
      if (pkg.publishConfig?.access !== "public") {
        errors.push(`Publishable package ${pkg.name} must set publishConfig.access = "public".`);
      }
      if (pkg.publishConfig?.provenance !== true) {
        errors.push(`Publishable package ${pkg.name} must set publishConfig.provenance = true.`);
      }
      if (typeof pkg.main !== "string" || !pkg.main.startsWith("dist/")) {
        errors.push(`Publishable package ${pkg.name} must point "main" at dist/.`);
      }
      if (typeof pkg.types !== "string" || !pkg.types.startsWith("dist/")) {
        errors.push(`Publishable package ${pkg.name} must point "types" at dist/.`);
      }
    }
  }

  return errors;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isMain) {
  const errors = validateReleaseConfig(process.cwd());
  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`::error::${err}`);
    }
    process.exit(1);
  }
  console.log(
    "Release configuration (.releaserc.json, CHANGELOG.md, .changeset/config.json, packages/*/package.json) is valid.",
  );
}
