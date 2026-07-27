# Conventional Commits

Every commit message must follow [Conventional
Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Examples from this repo's own history:

```
feat: add structured pino logger to shared-kernel (Issue 008)
fix: correct redaction path for nested tokens
docs: clarify configuration fail-fast behavior
```

## Enforcement

- **Locally**: a Husky `commit-msg` hook runs `commitlint` (config in
  `commitlint.config.cjs`, extending `@commitlint/config-conventional`) on
  every commit. A non-conventional message is rejected immediately, before
  the commit is even created.
- **In CI**: `.github/workflows/commitlint.yml` re-checks every commit in a
  pull request, so a message can't slip through via `--no-verify` or a commit
  made outside a machine with the hook installed.

## Common types

| Type       | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| `feat`     | a new feature                                             |
| `fix`      | a bug fix                                                 |
| `docs`     | documentation only                                        |
| `refactor` | code change that neither fixes a bug nor adds a feature   |
| `test`     | adding or correcting tests                                |
| `chore`    | tooling/config changes that don't affect the shipped code |

## Why this matters: it's not just style

Conventional Commits exists to make commit history **machine-readable**, not
just tidier. Phase 19 adds automated release tooling
(`semantic-release`) that determines the next version number and generates
the changelog directly from commit messages — nothing needs to be typed by
hand at release time, but only if every commit already carries the
information the tooling needs:

- `fix: ...` → patch release (`1.2.3` → `1.2.4`)
- `feat: ...` → minor release (`1.2.3` → `1.3.0`)
- `feat!: ...` or a `BREAKING CHANGE:` footer → major release (`1.2.3` → `2.0.0`)

A commit message that just says `updates` or `wip` carries none of this — a
human has to go read the diff to figure out what actually changed and
whether it matters for the next release. Conventional Commits front-loads
that classification to the person who has the most context to make it: the
one writing the commit.
