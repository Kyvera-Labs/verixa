# Static Analysis: Security Lint Rules

A code review catches the vulnerability the reviewer thought to look for.
Static analysis catches the pattern, every time, including on the pull request
written at 5pm by someone who has not read this file.

Roadmap Issue 208. Ruleset: `infra/ci/security-lint-rules.mjs`. Wired into the
existing lint job through `eslint.config.mjs`, so it runs wherever `pnpm lint`
does — locally, in `ci.yml`, and in the pre-commit hook.

## The shape of the change

`eslint-plugin-security` was already a dependency and its `recommended` set was
already loaded, with every rule on `warn`. That is a report, not a gate: warnings
do not fail `pnpm lint`, so a security regression merged green.

The ruleset now lives in one module, `infra/ci/security-lint-rules.mjs`, which:

- turns the **low-noise rules for real vulnerability classes** into `error`, so
  a finding fails the build;
- leaves one broad heuristic (`detect-object-injection`) on `warn`, because its
  false-positive rate makes it a review aid, not a gate;
- turns **two rules off** that can only fire on frameworks this repository does
  not use.

It is a separate module rather than an inline block for one reason: the fixture
tests in `tests/ci/security-lint.spec.ts` import the same object. A test that
re-declared the rules would prove the _test's_ rules fire, not the repository's.

Scoping that is not a promotion or demotion lives in `eslint.config.mjs`:

- `security/detect-non-literal-fs-filename` stays an **error** in shipped code
  and a **warning** in `tests/**`, `**/*.spec.ts` and the CI tooling under
  `infra/ci/**/*.ts`. Those write to `mkdtempSync` paths and to paths the
  workflow passes in; neither is an attack surface, and a build that fails on a
  correct fixture is a build people stop trusting.

## What is enforced, and why each rule

| Rule                                             | Severity | What it catches                                                                 |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------- |
| `security/detect-eval-with-expression`           | error    | `eval(userInput)` — arbitrary code execution from a string.                     |
| `security/detect-child-process`                  | error    | `child_process.exec(userInput)` — command injection.                            |
| `security/detect-non-literal-fs-filename`        | error    | `fs.readFileSync(userPath)` — path traversal and arbitrary file read.           |
| `security/detect-non-literal-regexp`             | error    | `new RegExp(userInput)` — regex injection.                                      |
| `security/detect-non-literal-require`            | error    | `require(userInput)` — arbitrary module load.                                   |
| `security/detect-unsafe-regex`                   | error    | Catastrophic backtracking, a denial-of-service primitive.                       |
| `security/detect-pseudoRandomBytes`              | error    | `crypto.pseudoRandomBytes` — not cryptographically secure.                      |
| `security/detect-buffer-noassert`                | error    | The `noAssert` argument skips `Buffer` bounds checks.                           |
| `security/detect-new-buffer`                     | error    | The deprecated, historically uninitialized `Buffer` constructor.                |
| `security/detect-possible-timing-attacks`        | error    | Non-constant-time comparison of a secret-shaped value.                          |
| `security/detect-bidi-characters`                | error    | Trojan-source control characters that hide code from a reviewer.                |
| `security/detect-object-injection`               | warn     | Dynamic property access — real for attacker-controlled keys, noise otherwise.   |
| `security/detect-disable-mustache-escape`        | off      | Server-rendered Mustache templates; this API serves JSON.                       |
| `security/detect-no-csrf-before-method-override` | off      | Express `method-override` middleware; the API is Fastify (Issue 205 owns CSRF). |

### Why `object-injection` is not an error

`object[userKey]` and `object[literalFromAClosedUnion]` are the same rule
finding. In a TypeScript codebase where the boundary is validated, the second
is the common case — `request.body[name]` inside a lookup table, a
`Record<Union, T>` indexed by a value the compiler already narrowed. Promoting
the rule to `error` would mean either hundreds of suppressions or a rewrite that
makes correct code worse, and both end with the rule turned off entirely.

It is left at `warn` deliberately, so it appears in review next to the code,
and it is the one rule whose fixture must still fire — the fixture proves the
rule works at the severity it is configured with.

### The three reviewed exceptions

Three existing findings were reviewed rather than suppressed wholesale, and each
carries an `eslint-disable-next-line` with the reasoning inline:

- `packages/stellar-anchor/application/ports/account-balance.ts` — a decimal
  amount regex with a bounded fractional group. `safe-regex`'s heuristic flags
  the shape, not a reachable backtracking case.
- `packages/authorization/domain/dsl/operators.ts` — compiling the pattern
  operand of the policy `matches` operator. The pattern is admin-authored policy,
  not caller input, and an invalid one is already mapped to `invalid_pattern`.
- `packages/credentials/application/use-cases/confirm-email-verification.ts` —
  a null check on a lookup result whose operand happens to be named `token`. The
  actual secret comparison calls a constant-time method.

A suppression without a paragraph like those is a removal of the control, and
should be reviewed as one.

## How the fixtures prove the ruleset works

`infra/ci/lint-security-fixtures/` contains one deliberately vulnerable snippet
per enabled rule. They are **not** real code and are ignored by
`eslint.config.mjs`, so `pnpm lint` never fails on them. A separate fixture
config, `infra/ci/lint-security-fixtures/eslint.config.mjs`, applies the shared
ruleset to that directory and nothing else.

`tests/ci/security-lint.spec.ts` then:

1. asks ESLint `--print-config` which security rules are enabled for a fixture
   file and at what severity;
2. runs ESLint `--format json` across the fixtures and collects which rules
   fired;
3. asserts that **every enabled rule fired on at least one fixture**, that the
   named vulnerability classes are enabled, that the two non-applicable rules
   are off, and that `eslint.config.mjs` uses the shared module rather than a
   copy.

The consequence worth stating: adding a rule to the shared ruleset without a
fixture fails the test suite. A lint rule nobody can demonstrate firing may
already be broken by a plugin upgrade — the plugin's own recommended set has
changed across majors, and this suite is what notices.

## Local use

```bash
pnpm lint                                              # the whole repository
pnpm exec eslint packages/identity --quiet             # errors only, one package
pnpm exec eslint infra/ci/lint-security-fixtures \
  --no-config-lookup \
  --config infra/ci/lint-security-fixtures/eslint.config.mjs \
  --format json
```

The last command is what the fixture test runs; it exits non-zero because the
fixtures are errors by design.

## What is deliberately not here

- **Type-aware dataflow analysis.** `eslint-plugin-security` is pattern
  matching. Following a value from an HTTP boundary to a sink is a different
  tool and a different issue; the injection review (Issue 210) and the pen test
  (Issue 217) cover the classes this cannot.
- **A hard gate on `object-injection`.** See above.
- **Formatting or style rules.** Those are `prettier`'s job and are unaffected
  by this change.
- **A second linter.** Semgrep and CodeQL both add real value, and both add a
  second configuration surface, a second suppression syntax, and a second
  place for a rule to silently stop working. One enforced ruleset with fixture
  evidence beats two whose findings disagree.
