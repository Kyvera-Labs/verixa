/**
 * CycloneDX SBOM generator (Issue 215).
 *
 * Turns `pnpm-lock.yaml` into a machine-readable inventory of every package a
 * release installs, and validates the result against the CycloneDX 1.6 JSON
 * schema before writing it.
 *
 * Why the lockfile is the source of truth, rather than the installed tree:
 * - The lockfile is the only artifact here that is *reviewed*. `node_modules` on
 *   a release runner also reflects install-script behaviour, platform-specific
 *   optional dependencies and whatever that runner had cached, so a BOM built
 *   from it describes one machine rather than the release.
 * - The existing CycloneDX npm tooling shells out to `npm ls`, which does not
 *   understand pnpm's symlinked, peer-disambiguated store — it reports the tree
 *   npm would have built, not the graph this repository declares. Reading
 *   `pnpm-lock.yaml` directly is the difference between an inventory and a guess.
 * - Resolved versions and integrity hashes are already in the lockfile, so this
 *   needs no network and two runs of the same commit agree on every package.
 *
 * What is deliberately absent from the output, and why:
 * - License expressions. They are not in the lockfile. Joining them in from each
 *   installed package's `package.json` would tie the SBOM to a completed install,
 *   and partially-filled license fields are worse than absent ones: an auditor
 *   cannot tell "no license declared" from "nobody looked".
 * - `scope: optional` on development-only packages. Marking them optional tells
 *   vulnerability scanners they may be skipped, and a dependency that only ever
 *   runs in CI still runs code fetched from the registry — that is the delivery
 *   path several well-known supply-chain attacks took. Everything this generator
 *   finds is therefore reported as part of the build.
 *
 * Usage:
 *   pnpm sbom:generate [--repo <path>] [--output <path>]
 *   pnpm sbom:generate --validate-only <path-to-bom>
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { Version as SpecVersion } from "@cyclonedx/cyclonedx-library/Spec";
import { JsonValidator } from "@cyclonedx/cyclonedx-library/Validation";
import { parse as parseYaml } from "yaml";

/** The CycloneDX spec version emitted and validated against. */
const SPEC_VERSION = SpecVersion.v1dot6;

const IMPORTER_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
const SNAPSHOT_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

/** Marks a component as this repository's own code rather than a registry package. */
const WORKSPACE_PATH_PROPERTY = "verixa:workspacePath";

interface CycloneDxComponent {
  readonly type: string;
  readonly "bom-ref": string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly licenses?: readonly { readonly license: { readonly id: string } }[];
  readonly hashes?: readonly { readonly alg: string; readonly content: string }[];
  readonly properties?: readonly { readonly name: string; readonly value: string }[];
}

class SbomError extends Error {}

/* ------------------------------------------------------------------ *
 * Narrowing helpers.
 *
 * The lockfile arrives as `unknown` and is checked by hand. A generator whose
 * output auditors rely on should fail loudly on a shape it does not recognise
 * rather than emit a BOM with packages quietly missing from it.
 * ------------------------------------------------------------------ */

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SbomError(`${context}: expected a mapping, found ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, context: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return asRecord(value, context);
}

function asString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new SbomError(`${context}: expected a string, found ${describe(value)}`);
  }
  return value;
}

/**
 * Names the shape that failed a check, without printing the value.
 *
 * A long scalar in the middle of these messages — a tarball URL, a base64
 * integrity hash — buries the field name, which is the only part a reader acts
 * on.
 */
function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "a list";
  }
  if (typeof value === "object") {
    return "a mapping";
  }
  return `a ${typeof value}`;
}

/**
 * Drops pnpm's peer-dependency suffix from a version or lockfile key.
 *
 * `vitest@3.2.7(@types/node@22.20.4)` and `vitest@3.2.7` are the same bytes on
 * disk — the suffix only records which peer combination a resolution graph used,
 * and those variants live in `snapshots:`. Collapsing them into one component is
 * what keeps the BOM honest: a list that names `vitest` three times for three
 * peer sets describes three packages that do not exist.
 */
function stripPeerSuffix(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ")") {
    let depth = 0;
    let start = -1;
    for (let index = end - 1; index >= 0; index -= 1) {
      if (value[index] === ")") {
        depth += 1;
      } else if (value[index] === "(") {
        depth -= 1;
        if (depth === 0) {
          start = index;
          break;
        }
      }
    }
    if (start === -1) {
      // Unbalanced parentheses are not a peer suffix, and not something to
      // guess at — hand it back and let the lookup that needs it report a miss.
      return value;
    }
    end = start;
  }
  return value.slice(0, end);
}

/** Splits a pnpm `packages:`/`snapshots:` key into a name and a resolved version. */
function splitPackageKey(key: string, context: string): { name: string; resolved: string } {
  const bare = stripPeerSuffix(key);
  // A scoped name starts with "@" and must not be split on that character.
  const separator = bare.lastIndexOf("@");
  if (separator <= 0) {
    throw new SbomError(`${context}: cannot split "${key}" into a package name and version`);
  }
  return { name: bare.slice(0, separator), resolved: bare.slice(separator + 1) };
}

/**
 * A Package URL for an npm package.
 *
 * The scope's leading `@` is percent-encoded and the `/` is left alone, matching
 * the purl spec's own npm examples (`pkg:npm/%40apidevtools/core@1.0.0`).
 */
function npmPurl(name: string, version: string): string {
  const encodedName = (name.startsWith("@") ? name.slice(1) : name)
    .split("/")
    .map((segment) => segment.replace(/[^a-zA-Z0-9._~+-]/gu, encodeURIComponent))
    .join("/");
  const prefix = name.startsWith("@") ? "%40" : "";
  const encodedVersion = version.replace(/[^a-zA-Z0-9._~+-]/gu, encodeURIComponent);
  return `pkg:npm/${prefix}${encodedName}@${encodedVersion}`;
}

/** `sha512-<base64>` from the lockfile, as CycloneDX's hex-encoded hash. */
function hashFromIntegrity(
  integrity: string,
  context: string,
): {
  readonly alg: string;
  readonly content: string;
} {
  const match = /^(\w+)-(.+)$/u.exec(integrity);
  const algorithm = match?.[1]?.toLowerCase();
  const digest = match?.[2];
  const alg =
    algorithm === "sha1" || algorithm === "sha256" || algorithm === "sha512"
      ? { sha1: "SHA-1", sha256: "SHA-256", sha512: "SHA-512" }[algorithm]
      : undefined;
  if (alg === undefined || digest === undefined) {
    throw new SbomError(`${context}: unrecognised integrity value "${integrity}"`);
  }
  return { alg, content: Buffer.from(digest, "base64").toString("hex") };
}

/* ------------------------------------------------------------------ *
 * Lockfile model
 * ------------------------------------------------------------------ */

interface ImporterDependency {
  readonly specifier: string;
  readonly version: string;
}

interface Lockfile {
  /** workspace path (`.` for the root) -> section -> package -> resolution */
  readonly importers: Map<string, Map<string, Map<string, ImporterDependency>>>;
  /** `name@version` from `packages:`, peer suffix removed */
  readonly packages: Map<string, { readonly integrity?: string }>;
  /** `name@version` from `snapshots:` -> the dependency edges of that resolution */
  readonly snapshots: Map<string, Map<string, string>>;
}

function readLockfile(repoRoot: string): Lockfile {
  const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
  const document = asRecord(parseYaml(readFileSync(lockPath, "utf8")), lockPath);

  const lockfileVersion = asString(document["lockfileVersion"], `${lockPath}: lockfileVersion`);
  if (!lockfileVersion.startsWith("9.")) {
    throw new SbomError(
      `${lockPath}: lockfileVersion ${lockfileVersion} is not supported here (this reads 9.x)`,
    );
  }

  const importers = new Map<string, Map<string, Map<string, ImporterDependency>>>();
  for (const [dir, sectionsValue] of Object.entries(
    asRecord(document["importers"] ?? {}, `${lockPath}: importers`),
  )) {
    const sections = new Map<string, Map<string, ImporterDependency>>();
    for (const [section, depsValue] of Object.entries(
      asRecord(sectionsValue, `importers.${dir}`),
    )) {
      if (!IMPORTER_SECTIONS.has(section)) {
        // `transitivePeerDependencies` records peer bookkeeping, not edges.
        continue;
      }
      const deps = new Map<string, ImporterDependency>();
      for (const [name, rawEntry] of Object.entries(
        asRecord(depsValue, `importers.${dir}.${section}`),
      )) {
        const context = `importers.${dir}.${section}.${name}`;
        const entry = asRecord(rawEntry, context);
        deps.set(name, {
          specifier: asString(entry["specifier"], `${context}.specifier`),
          version: asString(entry["version"], `${context}.version`),
        });
      }
      sections.set(section, deps);
    }
    importers.set(dir, sections);
  }

  const packages = new Map<string, { readonly integrity?: string }>();
  for (const [key, rawValue] of Object.entries(
    asRecord(document["packages"] ?? {}, `${lockPath}: packages`),
  )) {
    const { name, resolved } = splitPackageKey(key, `${lockPath}: packages`);
    const resolution = optionalRecord(
      asRecord(rawValue, `packages.${key}`)["resolution"],
      `packages.${key}.resolution`,
    );
    const integrity = resolution?.["integrity"];
    packages.set(
      `${name}@${resolved}`,
      integrity === undefined
        ? {}
        : { integrity: asString(integrity, `packages.${key}.resolution.integrity`) },
    );
  }

  const snapshots = new Map<string, Map<string, string>>();
  for (const [key, rawValue] of Object.entries(
    asRecord(document["snapshots"] ?? {}, `${lockPath}: snapshots`),
  )) {
    const { name, resolved } = splitPackageKey(key, `${lockPath}: snapshots`);
    const base = `${name}@${resolved}`;
    const edges = snapshots.get(base) ?? new Map<string, string>();
    const record = asRecord(rawValue, `snapshots.${key}`);
    for (const section of SNAPSHOT_SECTIONS) {
      const sectionValue = optionalRecord(record[section], `snapshots.${key}.${section}`);
      if (sectionValue === undefined) {
        continue;
      }
      for (const [dependency, version] of Object.entries(sectionValue)) {
        edges.set(dependency, asString(version, `snapshots.${key}.${section}.${dependency}`));
      }
    }
    snapshots.set(base, edges);
  }

  return { importers, packages, snapshots };
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

interface WorkspacePackage {
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly license?: string;
}

function readWorkspacePackage(repoRoot: string, dir: string): WorkspacePackage {
  const manifestPath = dir === "." ? "package.json" : `${dir}/package.json`;
  const manifest = asRecord(
    JSON.parse(readFileSync(path.join(repoRoot, manifestPath), "utf8")) as unknown,
    manifestPath,
  );
  const name = asString(manifest["name"], `${manifestPath}: name`);
  const version = asString(manifest["version"], `${manifestPath}: version`);
  const license = typeof manifest["license"] === "string" ? manifest["license"] : undefined;
  return {
    dir,
    name,
    version,
    purl: npmPurl(name, version),
    ...(license === undefined ? {} : { license }),
  };
}

/**
 * A component for one of this repository's own packages.
 *
 * The license is only published when it is a single SPDX identifier. Anything
 * else is an expression, and CycloneDX's `license.id` is an enum of individual
 * identifiers — inventing an encoding for expressions would produce a document
 * that validates while meaning something other than what the manifest said.
 */
function workspaceComponent(pkg: WorkspacePackage): CycloneDxComponent {
  const spdxId =
    pkg.license !== undefined && /^[A-Za-z0-9.\-+]{2,}$/u.test(pkg.license)
      ? pkg.license
      : undefined;
  return {
    type: "library",
    "bom-ref": pkg.purl,
    name: pkg.name,
    version: pkg.version,
    purl: pkg.purl,
    ...(spdxId === undefined ? {} : { licenses: [{ license: { id: spdxId } }] }),
    properties: [{ name: WORKSPACE_PATH_PROPERTY, value: pkg.dir }],
  };
}

/**
 * The purl of whatever a lockfile resolution actually installs.
 *
 * `link:` and `file:` point at workspace members and resolve through their own
 * manifests; everything else is a registry package that must be present in
 * `packages:`, because a resolution the lockfile cannot describe is exactly the
 * kind of thing an SBOM must not paper over.
 */
function purlForResolution(
  name: string,
  resolved: string,
  importerDir: string,
  context: { readonly workspaceByDir: Map<string, WorkspacePackage>; readonly lock: Lockfile },
): string {
  const bare = stripPeerSuffix(resolved);
  if (bare.startsWith("link:") || bare.startsWith("file:")) {
    const relative = bare.slice(bare.indexOf(":") + 1).replace(/\\/gu, "/");
    // pnpm writes `link:` paths relative to the importer that declared them and
    // `file:` paths relative to the repository root, so both readings are tried
    // before concluding the target is not a workspace package.
    const candidates = [
      path.posix.normalize(path.posix.join(importerDir, relative)),
      path.posix.normalize(relative),
    ];
    const pkg = candidates
      .map((candidate) => context.workspaceByDir.get(candidate))
      .find((found): found is WorkspacePackage => found !== undefined);
    if (pkg === undefined) {
      throw new SbomError(
        `importers.${importerDir} resolves ${name} to ${resolved}, which points at no workspace ` +
          "package in the lockfile",
      );
    }
    return pkg.purl;
  }
  const purl = npmPurl(name, bare);
  if (!context.lock.packages.has(`${name}@${bare}`)) {
    throw new SbomError(
      `importers.${importerDir} resolves ${name} to ${bare}, which has no packages: entry`,
    );
  }
  return purl;
}

interface BuildResult {
  readonly bom: Record<string, unknown>;
  readonly componentCount: number;
}

function buildSbom(repoRoot: string): BuildResult {
  const lock = readLockfile(repoRoot);

  const workspaceByDir = new Map<string, WorkspacePackage>();
  for (const dir of lock.importers.keys()) {
    workspaceByDir.set(dir, readWorkspacePackage(repoRoot, dir));
  }
  const root = workspaceByDir.get(".");
  if (root === undefined) {
    throw new SbomError("the lockfile has no importer for the workspace root");
  }

  const components = new Map<string, CycloneDxComponent>();
  const dependencies = new Map<string, Set<string>>();

  for (const pkg of workspaceByDir.values()) {
    if (pkg.dir !== ".") {
      components.set(pkg.purl, workspaceComponent(pkg));
    }
  }

  // Registry packages, from `packages:` — one component per name@version, no
  // matter how many peer combinations resolved to it.
  for (const [key, resolution] of lock.packages) {
    const { name, resolved } = splitPackageKey(key, "packages");
    if (resolved.startsWith("link:") || resolved.startsWith("file:")) {
      // A workspace member reached through a `file:` resolution. It is already a
      // component built from its own manifest, which carries a real version
      // rather than a path.
      continue;
    }
    const purl = npmPurl(name, resolved);
    const integrity = resolution.integrity;
    components.set(purl, {
      type: "library",
      "bom-ref": purl,
      name,
      version: resolved,
      purl,
      ...(integrity === undefined
        ? {}
        : { hashes: [hashFromIntegrity(integrity, `packages.${key}`)] }),
    });
  }

  // Direct edges: each workspace package to whatever its manifest declares.
  for (const [dir, sections] of lock.importers) {
    const source = workspaceByDir.get(dir);
    if (source === undefined) {
      continue;
    }
    const edges = dependencies.get(source.purl) ?? new Set<string>();
    for (const deps of sections.values()) {
      for (const [name, entry] of deps) {
        edges.add(purlForResolution(name, entry.version, dir, { workspaceByDir, lock }));
      }
    }
    dependencies.set(source.purl, edges);
  }

  // Transitive edges, from `snapshots:`.
  for (const [base, edges] of lock.snapshots) {
    const [sourceName, sourceVersion] = splitParts(base);
    if (sourceVersion.startsWith("link:") || sourceVersion.startsWith("file:")) {
      // A workspace member's own resolution. Its edges come from its importer
      // section, which resolves them against the workspace; the peer-suffixed
      // variants here would produce refs to packages that are not in the BOM.
      continue;
    }
    const sourcePurl = npmPurl(sourceName, sourceVersion);
    const collected = dependencies.get(sourcePurl) ?? new Set<string>();
    for (const [dependency, version] of edges) {
      const bare = stripPeerSuffix(version);
      if (bare.startsWith("link:") || bare.startsWith("file:")) {
        // A workspace sibling, already a component via the importer edges.
        continue;
      }
      // An aliased dependency (`string-width-cjs: string-width@4.2.3`) records the
      // real `name@version` in the value, so the name in the key is a local label
      // that no package carries.
      const aliasSeparator = bare.lastIndexOf("@");
      const target =
        aliasSeparator > 0
          ? { name: bare.slice(0, aliasSeparator), version: bare.slice(aliasSeparator + 1) }
          : { name: dependency, version: bare };
      if (!lock.packages.has(`${target.name}@${target.version}`)) {
        throw new SbomError(
          `snapshots.${base} depends on ${target.name}@${target.version}, which has no packages: entry`,
        );
      }
      collected.add(npmPurl(target.name, target.version));
    }
    dependencies.set(sourcePurl, collected);
  }

  const dependencyList = [...dependencies.entries()]
    .filter(([, targets]) => targets.size > 0)
    .map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() }))
    .sort((a, b) => a.ref.localeCompare(b.ref));

  const bom: Record<string, unknown> = {
    bomFormat: "CycloneDX",
    specVersion: SPEC_VERSION,
    // Not reproducible, deliberately: CycloneDX asks for a fresh serial number on
    // every generated BOM, even when the contents did not change, so that two
    // documents with the same serial number can be diffed for equality. Reparse
    // determinism would cost that property for no gain.
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "Kyvera Labs", name: "verixa SBOM generator", version: root.version }],
      // The release artifact is the monorepo, not one image inside it — today
      // that is what a tag actually designates.
      component: {
        type: "application",
        "bom-ref": root.purl,
        name: root.name,
        version: root.version,
        purl: root.purl,
      },
    },
    components: [...components.values()].sort(
      (a, b) => a.purl.localeCompare(b.purl) || a.version.localeCompare(b.version),
    ),
    dependencies: dependencyList,
    // A claim rather than decoration: every package the lockfile resolves became
    // a component, and the lockfile is a complete set by construction — which is
    // precisely why `node_modules` was left out of it above.
    compositions: [{ aggregate: "complete" }],
  };

  return { bom, componentCount: components.size };
}

function splitParts(base: string): [string, string] {
  const separator = base.lastIndexOf("@");
  if (separator <= 0) {
    throw new SbomError(`cannot split "${base}" into a package name and version`);
  }
  return [base.slice(0, separator), base.slice(separator + 1)];
}

/* ------------------------------------------------------------------ *
 * Validation and CLI
 * ------------------------------------------------------------------ */

/** Prints the validator's opaque ajv payload as readable lines. */
function describeValidationErrors(payload: unknown): string[] {
  if (!Array.isArray(payload)) {
    return [String(payload)];
  }
  return payload.map((item) => {
    if (typeof item !== "object" || item === null) {
      return String(item);
    }
    const error = item as { instancePath?: string; keyword?: string; message?: string };
    return `${error.instancePath ?? "/"} ${error.keyword ?? "?"}: ${error.message ?? "invalid"}`;
  });
}

async function validateSbom(serialized: string): Promise<string[]> {
  const validator = new JsonValidator(SPEC_VERSION);
  const error: unknown = await validator.validate(serialized);
  if (error === null || error === undefined) {
    return [];
  }
  return describeValidationErrors(error);
}

function cliFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

async function run(argv: readonly string[]): Promise<void> {
  const validateOnly = cliFlag(argv, "--validate-only");
  if (validateOnly !== undefined) {
    const errors = await validateSbom(readFileSync(validateOnly, "utf8"));
    if (errors.length > 0) {
      for (const error of errors.slice(0, 20)) {
        process.stderr.write(`sbom: ${validateOnly}: ${error}\n`);
      }
      throw new SbomError(
        `${validateOnly} is not a valid CycloneDX ${SPEC_VERSION} document (${String(errors.length)} schema error(s))`,
      );
    }
    process.stdout.write(`sbom: ${validateOnly} validates against CycloneDX ${SPEC_VERSION}\n`);
    return;
  }

  const repoRoot = path.resolve(cliFlag(argv, "--repo") ?? process.cwd());
  const outputPath = path.resolve(
    cliFlag(argv, "--output") ?? path.join(repoRoot, "sbom", "verixa.cdx.json"),
  );

  const { bom, componentCount } = buildSbom(repoRoot);
  const serialized = `${JSON.stringify(bom, null, 2)}\n`;

  // Validated before it is written: an artifact that no auditor's tool can parse
  // is worse than no artifact, because it looks like a supply-chain review
  // happened.
  const errors = await validateSbom(serialized);
  if (errors.length > 0) {
    for (const error of errors.slice(0, 20)) {
      process.stderr.write(`sbom: ${error}\n`);
    }
    throw new SbomError(
      `the generated BOM does not validate against CycloneDX ${SPEC_VERSION} — refusing to write it`,
    );
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized, "utf8");
  process.stdout.write(`sbom: wrote ${outputPath} — ${String(componentCount)} component(s)\n`);
}

run(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`sbom: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
