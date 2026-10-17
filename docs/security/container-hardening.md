# Container Hardening

A container image is a filesystem an attacker gets to keep. Whatever is in it
is available to whoever lands a shell in it, and the process inside it is the
thing holding the database credentials. So the rule:

**The shipped image contains the compiled output and the runtime that executes
it. Nothing that produced it, nothing that describes it, and nothing that
could be used to fetch more.**

Roadmap Issue 216. Implementation: `apps/api/Dockerfile` (the image),
`scripts/prune-runtime-bundle.mjs` (what leaves before it ships),
`.github/workflows/container-scan.yml` (the gate), and the `docker` job in
`.github/workflows/ci.yml` (the assertions that it stayed that way).

## What the image is

One image, `verixa-api`, built from `apps/api/Dockerfile` with the repository
root as its build context:

```bash
docker build -f apps/api/Dockerfile -t verixa-api .
```

| Stage     | Base             | Contains                                                     | Ships? |
| --------- | ---------------- | ------------------------------------------------------------ | ------ |
| `base`    | `node:22-alpine` | Node 22, Corepack-enabled pnpm                               | no     |
| `deps`    | `base`           | every workspace manifest, `pnpm install --frozen-lockfile`   | no     |
| `build`   | `deps`           | source, `tsc` output, generated Prisma client, `/out` bundle | no     |
| `runtime` | `node:22-alpine` | `/out` at `/app`, `node`, an unprivileged user, nothing else | yes    |

`runtime` starts from a fresh `node:22-alpine`, so it inherits no layer from the
stages that compiled anything. The only thing copied across is `COPY --from=build
--chown=verixa:verixa /out .`.

## Why the Dockerfile is at `apps/api/`, not `infra/docker/`

Issue 216 names `infra/docker/Dockerfile`. That path does not exist, and moving
the file to it is not part of this change:

- `apps/api/Dockerfile` predates the issue and is referenced as such by
  `docs/guides/docker.md`, the `docker` job in `ci.yml`, `container-scan.yml`,
  and the comment at the top of `docker-compose.yml`. A `git mv` would touch
  all four for no security gain and would make the PR about a path rather than
  about the image.
- The image is app-specific: it knows about `@verixa/api`, its workspace
  closure, and its `dist/` output. In a pnpm monorepo that knowledge belongs
  with the app, which is why the context is the root but the file is not.
- `infra/` currently holds Postgres role and database init scripts, which are
  environment configuration rather than build definitions.

If a second image appears — a worker, an anchoring job — `infra/docker/` becomes
the right shared home for the _pattern_, and that move should be its own
change with its own review.

## Minimal base: Alpine plus explicit pruning, not distroless

The issue allows either "distroless" or "slim + explicit package pruning". This
takes the second, for reasons that are all about what can be _proven_ about the
artifact:

- **The runtime is the thing under test.** The acceptance criteria are verified
  by executing `find`, `du`, `id` and `whoami` inside the running container. A
  distroless `static`/`nodejs` variant has no `/bin/sh`, so every one of those
  assertions has to be rebuilt outside the image against a filesystem snapshot.
  That is a real migration, not a tag swap, and it is not this issue's scope.
- **Prisma's engine is a native binary resolved at install time.** The build
  stage already carries the generated client into `/out` by hand because `pnpm
deploy` does not (see the comment in the Dockerfile). Keeping the same Node
  family the repository has been validating since the Dockerfile landed keeps
  that resolution on one known platform (`linux-musl`) instead of changing two
  variables at once.
- **The base image ships OS packages, and the gate exists for exactly that.**
  Alpine's apk set is the part of the image nobody can prune by hand — it is
  also the part that gets CVEs without a commit here. `container-scan.yml`
  blocks on those.

The honest cost: distroless would be smaller and would not carry `apk` at all.
If the project decides to move, the move is: relocate the content assertions to
an image-inspection step, re-verify the engine layout, and re-measure.

## Non-root, with a pinned UID

```dockerfile
RUN addgroup -S -g 10001 verixa && adduser -S -u 10001 -G verixa verixa
...
USER verixa
```

Container isolation is a process namespace, not a security boundary. If the
process is root and anything escapes — a kernel bug, a mounted socket, a
misconfigured capability — it escapes _as root on the host_. Running as an
unprivileged user removes that entire class in one line.

The UID and GID are pinned rather than left to Alpine:

- `runAsNonRoot: true` is satisfied by any non-zero UID, but
  `securityContext.runAsUser: 10001` and a volume whose ownership was set for
  this image both need the _number_ to be stable across builds.
- `--chown=verixa:verixa` on the copy means `/app` is owned by the user that
  reads it, so there is no path where the process needs to escalate to open its
  own files.

`ci.yml` asserts both the name (`whoami` is not `root`) and the number (`id -u`
and `id -g` are not `0`), because the number is what an orchestrator enforces.

## Tooling deleted from the runtime stage

```dockerfile
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/include/node
```

These are in `node:22-alpine` because the same image family is used to build.
In a production container they are post-compromise tooling:

- `npm`/`npx`/`corepack` turn a foothold into arbitrary code — `npm install
<anything>` fetches from a registry the operator never approved, into a
  container that already has the database credentials.
- `/usr/local/include/node` exists only to compile native addons. Nobody
  compiles in a runtime container, and a compiler toolchain that can be
  assembled there is a way to make that foothold persistent.

`node` itself stays; it is the only thing the image runs. The CI step
asserting all five paths are absent is what stops a future base-image change
from quietly putting them back.

## Pruned from the bundle, and how much that was

`pnpm deploy --prod` does exclude dev dependencies. It does not exclude
anything else, because no workspace package declares a `files` array, so
`deploy` copies each package directory _whole_ — which puts `apps/api/src/**`,
every package's `domain/` and `application/` trees, and the previous test run's
`coverage/` output into `/out`. Source maps and declarations arrive from
`tsconfig.base.json`, which sets `declaration`, `declarationMap` and
`sourceMap` for every package, and each suite compiles to a `*.spec.js` beside
its siblings.

`scripts/prune-runtime-bundle.mjs` removes:

| Pattern (recursive)                       | Why it is not needed at runtime                              |
| ----------------------------------------- | ------------------------------------------------------------ |
| `*.js.map`                                | contains the original TypeScript                             |
| `*.d.ts`, `*.d.ts.map`                    | type information; Node never loads it                        |
| `*.spec.js`                               | an executable description of every assumption the tests make |
| `*.ts` under the app root and `@verixa/*` | our own source, in plain text                                |
| `coverage/` directories                   | test output                                                  |

Measured on a real `pnpm --filter=@verixa/api deploy /out --prod` bundle, with
the script run against it:

```
pruned 2245 .d.ts file(s), 14.64 MiB
pruned 2093 .js.map file(s), 45.80 MiB
pruned  785 .d.ts.map file(s), 2.17 MiB
pruned  440 .ts (workspace source) file(s), 1.96 MiB
pruned  143 .spec.js file(s), 0.81 MiB
pruned   71 coverage/ file(s), 0.82 MiB
pruned 5707 entry(s), 66.20 MiB from /out
```

12,250 files and 276.0 MiB before the run, 6,544 files and 209.8 MiB after
(the 355 symlinks in the tree are skipped, not followed). Those figures are
from a bundle assembled on a Windows host and the MiB totals are dominated by
that platform's Prisma engine binaries; the number for _this image_ is the one
CI prints, below.

Two boundaries worth stating rather than guessing at:

- **Third-party `.ts` files are left alone** (799 files, 9.32 MiB in the same
  bundle). They are other projects' published artifacts, some of which resolve
  through them. This script's scope is what Verixa's own build put there.
- **The `coverage/` rule is redundant inside Docker** — `.dockerignore` already
  keeps `**/coverage` and `**/dist` out of the build context. It is there
  because the script's contract is about a deployed bundle, and the script is
  also runnable, and tested, outside a Docker build.

The remaining files at the root of `/app` are `dist/` (8 compiled `.js`),
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` and
the app's own `Dockerfile`. The last three are not secret — they are in the
repository — and the lockfile in the image is useful to whatever builds an SBOM
later. Deleting them would need its own justification; deleting our source does
not.

**Order matters:** the prune runs _before_ the Dockerfile's load proof, so the
proof (`node --input-type=module -e "await import('@verixa/database')…"`)
executes against the tree that actually ships. If the bundle turns out to need
a file this step removes, the build fails at that line rather than as a pod
crashing at 03:00.

## The scan gate

`.github/workflows/container-scan.yml` builds the same Dockerfile and scans the
result with Trivy:

| Step                     | Scope                                            | Fails the job? |
| ------------------------ | ------------------------------------------------ | -------------- |
| OS packages              | `HIGH,CRITICAL`, `--ignore-unfixed`, exit 1      | **yes**        |
| Application dependencies | `HIGH,CRITICAL`, JSON artifact, 30-day retention | no             |
| Size and layer report    | `docker images`, `docker history`                | no             |

Design decisions, each of which somebody should be able to disagree with:

- **Only OS packages block.** That is the acceptance criterion, and it is the
  one class the application cannot fix for itself: an Alpine `libcrypto`
  advisory means the base image moves, and no source file here is involved.
  Dependency advisories are Issues 207 and 208's territory (`pnpm audit` in CI,
  lockfile integrity, Dependabot). A second blocking gate on the same
  advisories would be red most of the time, and a check that is always failing
  is not a check.
- **`--ignore-unfixed`.** For an advisory with no released patch there is no
  action available, so failing the build trains everyone to ignore the failure.
  When upstream ships a fix, the advisory stops being ignored and the gate
  closes on its own.
- **Its own workflow, and a schedule.** An image that passed on the day it was
  built can contain a vulnerability by Friday. `17 4 * * 1` (off-round, because
  scheduled runs for public repos come out of a congested shared queue) is how
  that gets noticed with nobody having to remember it. Keeping it out of
  `ci.yml` means a newly published advisory arrives as its own failure with the
  scan output as the whole story, instead of a red X on a pull request that
  touched a README.
- **`permissions: contents: read`, no `issues: write`.** Auto-filing one issue
  per CVE is how a project ends up muting its own scanner. A human decides what
  gets opened.
- **The action is pinned to a commit SHA** (`ed142fd…`, v0.36.0). This step is
  the thing that decides whether a vulnerable image ships; the version that
  decides it should not be able to move underneath a review.
- **Trivy rather than `docker scan`.** Docker deprecated its built-in scanner
  in favour of Scout, which wants an image in a registry; this repository does
  not publish one yet, and scanning a registry tag would not be scanning the
  Dockerfile under review.

`.trivyignore` at the repository root is intentionally empty. Adding to it is a
claim that a vulnerability does not need fixing, and the file states the bar:
advisory id, why the code path is unreachable here, and what would change that.
The workflow's failure step prints the same remediation path.

## Where the image size number comes from

The issue asks for the final image size to be documented. It is not stated
here, because the machine that produced this change has no Docker daemon on it
and an invented figure would be the kind of number someone later cites as
evidence.

CI measures it on the commit. The `docker` job in `ci.yml` prints
`docker images verixa-api:ci --format 'size {{.Size}}'` plus `du -sh /app` and
a file count inside the running container, and `container-scan.yml` prints the
same for its own build with per-layer sizes. Whoever next touches the
Dockerfile should put the measured figure here, or delete this section as
unnecessary.

## Verification matrix

| Acceptance criterion                                          | Where it is enforced                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Final image runs as non-root                                  | `USER verixa` + the two `ci.yml` steps (`whoami`, `id -u`/`id -g`)             |
| CI scan fails on HIGH/CRITICAL OS-package vulnerabilities     | `container-scan.yml`, blocking Trivy step, `exit-code: "1"`                    |
| Size and contents documented, no dev dependencies, build test | this file, the `ci.yml` content assertions, the measured prune log             |
| Multi-stage build excluding dev deps and source maps          | four stages + `pnpm deploy --prod` + `prune-runtime-bundle.mjs`                |
| Minimal base image (distroless _or_ slim + explicit pruning)  | `node:22-alpine` with the five deletions and the bundle prune                  |
| Tests for the build step                                      | `tests/integration/prune-runtime-bundle.spec.ts` (9 run, 1 skipped on Windows) |

## What is not claimed

Stated plainly, because a hardening document that overreaches is worse than no
document:

- No image was built or scanned locally. Docker is not installed on the machine
  that wrote this, so every assertion that needs a daemon — the `ci.yml`
  content steps, the Trivy gate, the size figures — is unexecuted until this
  branch's CI run.
- The part that does not need Docker is tested here: the prune script runs as a
  subprocess against a real directory tree in
  `tests/integration/prune-runtime-bundle.spec.ts`, and the numbers above come
  from running it against a real `pnpm deploy --prod` output.
- The workflow files were checked by parsing them (Prettier reads YAML), not by
  running them.

## Changing this image

1. The build context is the repository root; the Dockerfile copies every
   workspace manifest rather than an enumerated list, so adding a workspace
   dependency needs no Dockerfile edit.
2. If a new stage puts files in `/out`, decide whether the running process
   reads them. If not, add the rule to `PRUNED_SUFFIXES`,
   `PRUNED_DIRECTORIES` or `categoryOf`, add a case to the prune spec, and add
   the matching `find` to the CI assertion step. All three, or the next
   contributor finds out from a red build.
3. A base-image change means re-running `container-scan.yml` _and_ the
   `docker` job together; a new Node flavor can move the tooling paths and the
   UID's meaning at the same time.
4. Never add a package manager back to the runtime stage. If a native addon
   must be compiled, compile it in `build` and copy the `.node` file.
5. The clean fix that would make the workspace-`.ts` rule unnecessary is a
   `files` array (`["dist"]`, plus `prisma/**` for `@verixa/database`) in each
   workspace `package.json`, so `pnpm deploy` stops copying source trees at
   all. That changes packaging for eleven packages and belongs in its own PR.

## Related

- [docs/guides/docker.md](../guides/docker.md) — how to build and run the image,
  the compose stack, and the four-stage walkthrough.
- [docs/security/tls-enforcement.md](./tls-enforcement.md) — the TLS-termination
  point in front of this container, and why `TRUST_PROXY` has to match it.
- [docs/security/pen-test-checklist.md](./pen-test-checklist.md) — the manual
  exercise that checks what a scanner cannot.
- [Roadmap Issue 216](../../planning/issues/phase-11-security-hardening.md) —
  dependencies on Issue 207 (dependency advisories) and follow-on Issue 218
  (incident response, where the remediation step above becomes a runbook).
