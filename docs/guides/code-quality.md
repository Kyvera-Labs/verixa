# Code quality gate

Every pull request runs a **Code quality** check (`.github/workflows/quality.yml`).
It measures only what the pull request changes, so an old, untidy file never
blocks someone who fixed one line of it.

## What it measures

| Gate              | Question it answers                                                                                                                    | Default limit                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packageCoverage` | Does every package you changed still meet the coverage thresholds in its own `vitest.config.ts`?                                       | the package's own thresholds                                                            |
| `patchCoverage`   | Do your tests actually run the lines you added or changed?                                                                             | 80% of changed executable lines                                                         |
| `complexity`      | Is the code you changed still easy to read and review?                                                                                 | complexity 12, nesting depth 4, 80 lines per function, 5 parameters, 3 nested callbacks |
| `prTitle`         | Is the pull request title a [Conventional Commit](https://www.conventionalcommits.org/)? It becomes the squash-merge commit on `main`. | `type(scope): subject`                                                                  |

Blank lines, comments and type-only lines don't count toward patch coverage.
Test files are never measured for coverage or complexity.

## Reading the result

The job summary (the **Summary** tab of the workflow run) has a table with one
row per gate. Findings also appear as annotations on the exact lines in the
pull request's **Files changed** tab.

- **pass**: nothing to do.
- **warn**: the gate found something, but it is not blocking yet. Please fix
  it anyway. The summary says when the gate is planned to start blocking.
- **fail**: a blocking gate found something, and the check is red.
- **not-run**: the measurement step crashed. Look at that step's log.

## Fixing common findings

- **Changed line not executed by any test:** add a test that reaches it. If
  the line is genuinely unreachable (a defensive `default:` in an exhaustive
  switch, for example), say so in the pull request. A reviewer can accept it.
- **Complexity:** split the function. A function with complexity above 12 is
  almost always doing two things. If a limit is truly wrong for one function,
  disable it on that line and explain why:
  `// eslint-disable-next-line complexity -- one branch per HTTP status, kept flat on purpose`
- **Title:** edit the pull request title, e.g. `feat(identity): add email change use case`.
  Allowed types are the conventional ones: `feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`, `ci`, `build`, `perf`, `style`, `revert`.

## For maintainers: changing a gate

Every gate is configured in `infra/ci/quality-gates.json`:

```json
"patchCoverage": { "mode": "warn", "minPercent": 80, "blockFrom": "2026-12-02" }
```

- `mode`: `off`, `warn` or `block`. Only `block` can fail the check.
- `blockFrom`: shown to contributors while the gate warns. It's informational;
  nothing switches automatically.
- Limits (`minPercent`, `limits`): tune these here, never in the workflow.

**Promoting a gate:** after about two weeks in `warn`, look at what it flagged
on recent pull requests. If the warnings were right, change `mode` to `block`
in a pull request of its own. If they were noisy, adjust the limit first.

The check itself, **Code quality**, can be a required status check from day
one. While every gate is in `warn` it never fails, and once a gate is promoted
the requirement takes effect without touching branch protection again.

A `block` gate whose measurement produced no result **fails**. A crashed
measurement has not passed, and treating it as a pass would let a broken step
silently disable the gate.

`infra/ci/` is a CODEOWNERS path, so loosening a gate is a reviewed change
like any other.

## Running it locally

The gate script needs no dependencies:

```bash
node infra/ci/quality-gate.mjs eslint-rule-args --config infra/ci/quality-gates.json
pnpm --filter @verixa/identity run test:coverage --coverage.reporter=lcov
```

Its tests are in `tests/ci/quality-gate.spec.ts`.
