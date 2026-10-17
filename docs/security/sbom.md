# SBOM & Lockfile Integrity

Two halves of one question. `infra/ci/generate-sbom.ts` answers _what is in this
release_; `infra/ci/check-lockfile-integrity.mjs` answers _can that answer be
trusted_. They are one issue because the second is a precondition of the first —
a bill of materials generated from a dependency graph nobody reviewed is a
documented guess.

Both read `pnpm-lock.yaml`, and neither talks to the network.

## The artifact

A release tag (`v*.*.*`) runs `.github/workflows/release.yml`, which writes
`sbom/verixa.cdx.json`, validates it against the CycloneDX 1.6 JSON schema,
uploads it as a workflow artifact, and attaches it to the GitHub Release.

At the time of writing the real tree produces 695 components and 297 dependency
edges. The file is not committed — it is a build output, it changes whenever a
dependency does, and putting it in git would mean every dependency PR carries a
thousand-line diff that no reviewer reads. `.gitignore` says so.

To produce one locally:

```bash
pnpm sbom:generate                              # writes sbom/verixa.cdx.json
pnpm sbom:generate --validate-only <file>       # validates any BOM, generated or not
```

## Why the lockfile is the source of truth

Every alternative is a completed install, and a completed install is not a
reviewed artifact:

- **`node_modules` on the release runner** reflects install-script behaviour,
  platform-specific optional dependencies, and whatever that runner happened to
  have cached. A BOM built from it describes one machine rather than the release.
- **The CycloneDX npm tools** shell out to `npm ls`, which does not understand
  pnpm's symlinked, peer-disambiguated store. It reports the tree npm _would_
  have built, not the graph this repository declares.
- **`pnpm list --json --depth=Infinity`** is the true installed tree, and still
  requires an install on a specific platform before it can answer.

`pnpm-lock.yaml` is the only dependency artifact that goes through review — it
has a diff, an author, and a failing CI job when it disagrees with the manifests.
It also already contains the resolved version and the `sha512` integrity for
every package, which is exactly what a BOM needs, so the generator needs no
network and two runs of the same commit agree on every package.

The cost of reading it directly is a hand-written parser for the shape pnpm
emits. That is the right trade: it refuses entries it does not recognise rather
than guessing, so a pnpm format change produces an error rather than a silently
smaller BOM.

### Peer-suffixed keys collapse into one component

`packages:` keys are package identities; `snapshots:` keys carry pnpm's peer
suffix — `vitest@3.2.7(@types/node@22.20.4)`. Those two are the same bytes on
disk; the suffix records which peer combination a resolution graph used, not a
distinct artifact. Emitting one component per peer variant would name three
`vitest` packages that do not exist and would make the scanner's join on
`purl` miss two of them.

Unbalanced parentheses are not treated as a suffix. They are handed back, and
the lookup that needs them reports the miss — inventing a meaning for a shape
this parser does not recognise is how a wrong BOM gets written.

### purls use `%40` for the scope

`pkg:npm/%40fastify/helmet@13.2.0`, per the purl spec's own npm examples. The
leading `@` is not a valid character in that position; consumers join on the
purl, so getting the encoding wrong means the tool "has no data" for every scoped
package — which is most of the tree here.

## What is deliberately absent

**No license expressions.** They are not in the lockfile. Joining them in from
each installed package's `package.json` would tie the SBOM to a completed
install, and partially-filled license fields are worse than absent ones: an
auditor cannot tell "no license was declared" from "nobody looked". Absence here
is a stated, reviewable gap rather than an inaccurate claim.

**No `scope: optional` on development dependencies.** Marking them optional
tells a vulnerability scanner that they may be skipped, and a dependency that
only ever runs in CI still runs code fetched from the registry — that is the
delivery path several well-known supply-chain attacks took. Everything the
lockfile resolves is therefore reported as part of the build. The BOM is bigger
than what production serves; being too inclusive is the direction to be wrong.

**No reproducible `serialNumber`.** A fresh `urn:uuid` per run, deliberately:
CycloneDX asks for one so that two documents sharing a serial number can be
diffed for equality. Everything _else_ is sorted (components by purl then
version, dependency edges by ref), so a diff between two runs is a diff of the
dependency graph plus the timestamp, and nothing more.

## Validation, and why it happens before the write

An artifact that no auditor's tool can parse is worse than no artifact, because
it looks like a supply-chain review happened. So the generator serialises,
validates with `@cyclonedx/cyclonedx-library`'s `JsonValidator` against the
bundled CycloneDX 1.6 schema, and refuses to write the file if validation fails.
`release.yml` validates the written file a second time with `--validate-only` —
the release path fails rather than publishing a malformed BOM.

The validator needs `ajv`, `ajv-formats`, and `ajv-formats-draft2019` as peers
(the 1.6 schema uses draft-2019 keywords), which is why they appear in
`package.json` rather than being pulled in transitively.

## The lockfile integrity gate

`.github/workflows/ci.yml` runs it as the first step after checkout, before
pnpm is installed — invoked as `node infra/ci/check-lockfile-integrity.mjs`, not
`pnpm run check:lockfile`, because it exists to diagnose a tree that has never
been installed. Same reason it is plain JavaScript with zero dependencies and a
hand-written reader: a gate that needs an install to run cannot guard the
install.

What it reports, in one pass, naming the manifest file and the dependency:

1. A manifest dependency the lockfile does not list.
2. A specifier that no longer matches what the lockfile recorded.
3. A dependency still locked but no longer in a manifest.
4. A workspace package with no importer entry, and an importer entry with no
   workspace package.
5. A resolution with no `packages:` entry — a truncated or hand-edited lockfile.
6. A floating range (`*`, `latest`, `4.x`) in any manifest.
7. No lockfile at all, or a lockfile that exists on disk but is not tracked by
   git.
8. A `lockfileVersion` this reader does not understand.

### Why this exists when CI already runs `pnpm install --frozen-lockfile`

`--frozen-lockfile` is a _resolver precondition_, not a review tool. It stops at
the first mismatch with a pnpm-internal resolution message, so you learn about
one problem in a workspace of fourteen packages. It says nothing about floating
ranges — a lockfile can satisfy `"left-pad": "*"` perfectly and still describe a
graph that changes underneath a rebuild, because the next resolution of the same
manifest is free to pick something newer. Rejecting floats at the manifest is the
only point where that choice is still cheap to reverse.

And it says nothing about whether the lockfile is _committed_. That is the
failure with the widest blast radius: everything passes locally, and CI silently
resolves a fresh graph on every build while continuing to report the same green.
A missing lockfile would otherwise surface three steps downstream as `setup-node`
complaining it cannot find a lockfile to key its cache from.

`workspace:*` ranges are exempt from the float rule. They point at a package in
this repository and the lockfile records the resolved link, so "floating" there
means "tracks our own version", not "tracks whatever the registry publishes
next".

### Why a `lockfileVersion` bump has to be an edit here

The gate reads the 9.x format and refuses anything else rather than parsing it.
Upgrading pnpm should force someone to look at what this check actually
verifies; a reader that quietly accepts a format it was not written for is one
that quietly returns zero problems.

## Where this does not reach

The SBOM is an inventory, not a verdict. Knowing every package in a release is
what makes a disclosure actionable — "is any of it affected" is a different
question, and it is answered elsewhere: `contributor-checks.yml` runs
`pnpm audit --audit-level high` on any PR that changes the lockfile, so the
advisory scan happens at the moment the graph changes rather than at release
time when the fix is expensive.

Neither tool checks what a package _does_. That is install-script and provenance
territory, and it needs artifact attestations rather than a component list.

## Testing

`tests/ci/lockfile-integrity.spec.ts` and `tests/ci/sbom.spec.ts` run the real
scripts as subprocesses against temporary git fixtures — a two-package workspace
with a valid lockfile, then the same fixture drifted one way at a time. The
drifted fixture the issue asks for is the test that a manifest gained
`new-thing@^9.1.0` while the lockfile never saw it: exit 1, with the manifest
path and the dependency named in stderr.

Running them as subprocesses rather than importing the modules is the point. The
gate's contract is an exit code and a stderr line that CI consumes, and a test
that imported it would pass on a script CI cannot execute.
