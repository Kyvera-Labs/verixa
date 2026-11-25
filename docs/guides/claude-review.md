# Automated pull request review (Claude)

`.github/workflows/claude-review.yml` gives every pull request an automated
first-pass review: inline comments on specific lines, plus one summary comment
with a verdict.

It's **advice for the maintainer, not a gate**. It can't approve, request
changes, push or merge. The maintainer reads every pull request and makes the
decision.

## When it runs

| Pull request from           | Reviewed                                                       |
| --------------------------- | -------------------------------------------------------------- |
| A branch of this repository | Automatically when opened, reopened or marked ready for review |
| A fork (most contributors)  | When a maintainer comments **`@claude review`** on it          |
| Anyone, after new pushes    | When a maintainer comments **`@claude review`** again          |

Fork pull requests aren't reviewed automatically because a fork's workflow run
gets no secrets. The only way around that, `pull_request_target`, would give
the API key to a run that a stranger can trigger. A maintainer's comment is the
deliberate, safe trigger. Only `OWNER`, `MEMBER` and `COLLABORATOR` comments
start a review.

## What it looks for

In this order: supply-chain and malware signs (the PolinRider patterns from
`docs/security/incidents/2026-10-polinrider.md`), correctness bugs, security
issues, the layering rules, missing or hollow tests, and scope creep. The full
instructions are in the workflow's `prompt`. Edit them there.

## Why it's safe to point at untrusted code

A pull request is attacker-controlled text, and an AI reviewer can be
prompt-injected by it. So the reviewer has nothing an injected prompt could
misuse:

- **Tools:** it can read files, read the diff and post comments. It has no
  shell, no package manager, no test runner and no file edits.
- **`restrict_untrusted_prs`:** on pull requests from authors without write
  access, the action also denies any command that runs code from the checkout.
- **Token:** it can write comments only. Contents are read-only.
- **Prompt:** the reviewer is told to treat everything in the pull request as
  data and to report any instructions it finds there.

## One-time setup

1. Install the **Claude GitHub App** on `Kyvera-Labs/verixa`:
   https://github.com/apps/claude
2. Create an API key in the Anthropic Console and add it as a repository
   secret named **`ANTHROPIC_API_KEY`** (Settings → Secrets and variables →
   Actions). Set a monthly spend limit on the key in the Console.
3. Comment `@claude review` on an open pull request to try it.

Until the secret exists, the job fails quickly with a missing-key error. It
isn't a required check, so it doesn't block merging.

## Cost

Each review is billed to the API key, and the cost scales with the size of the
diff. The workflow uses `claude-sonnet-5-5` with at most 25 turns per review to
keep the cost down. For a deeper review of a risky change, temporarily set
`--model` in `claude_args` to `claude-opus-5-5`.

Until the `ANTHROPIC_API_KEY` secret is added, the job skips with a notice
instead of failing, so it is safe to merge the workflow before the key exists. Automatic
reviews run only on open, reopen and ready-for-review, not on every push, so a
pull request with twenty pushes costs one review unless a maintainer asks for
more.
