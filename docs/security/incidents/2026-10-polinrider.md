# Incident 2026-10: PolinRider code injection in `eslint.config.mjs`

Post-incident review, following the template in
[`docs/security/incident-response-runbook.md`](../incident-response-runbook.md).

- **Incident lead / responders:** repository maintainer (BigManly4).
- **Severity:** high. Malicious code designed to run on contributors' machines
  reached `main`. It did not execute (see Impact), which is why this is not
  rated critical.
- **Detected:** 2026-10-17, during local verification of `main`, when ESLint
  crashed parsing `eslint.config.mjs`. Independently reported to the
  maintainers by the Drips Wave program on 2026-10-18.
- **Contained:** payload removed from `main` on 2026-10-18 (#336); remaining
  traces removed and CI gate added in the cleanup pull request on 2026-10-18.

## Summary

A contributor's pull requests carried code injected by **PolinRider**, a
publicly tracked malware campaign that infects a developer's machine and then
rewrites the repositories that developer pushes to. The evidence points to the
contributor being a victim rather than the author: their fork contains a forged
copy of an unrelated September merge commit, rewritten to carry the payload
under another person's name and date, which is this campaign's known behaviour.

The payload was a ~28,000-character block of obfuscated JavaScript appended to
line 63 of `eslint.config.mjs`, pushed out of view by roughly 1,000 spaces. It
looked up a command server's address in blockchain transaction data,
downloaded code from it, and ran that code in a detached, hidden `node`
process. Because ESLint loads `eslint.config.mjs`, it would have run on every
`pnpm lint` and every pre-commit hook. The same change added an import of
`createRequire` to give the payload `require` inside an ES module, and added
`temp_auto_push.bat`, `temp_interactive_push.bat` and `branch_structure.json`
to `.gitignore` to hide the campaign's push tooling.

## Impact

- **Confirmed:** the payload was present on `main` from 2026-10-17 (#332) until
  2026-10-18 (#336), and on the branches of #323–#327, #329 and #333.
- **Not observed — execution:** every version that reached this repository has
  a syntax error where the payload was spliced in (`},;`), so Node cannot parse
  the file and ESLint fails before running any of it. This matches CI, where
  the lint step failed with `SyntaxError: Unexpected token ';'`. No other
  PolinRider vector was ever present in any branch: no `.vscode/tasks.json` or
  `.vscode/settings.json`, no `dist/setup.js`, no install lifecycle scripts, no
  font files, no known-malicious packages.
- **Not observed — maintainer machine:** all 50 git repositories on the
  maintainer's machine were scanned for the campaign's markers and file shapes
  with no hits, and no unfamiliar scheduled tasks, startup entries, hidden
  `node -e` processes or global git hooks were found.
- **Possible, outside this project's control:** the contributing machine is
  likely compromised. The contributor was contacted privately with cleanup
  steps.

## Timeline (UTC)

| When                   | Event                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 23:57       | First infected commit in the contributor's fork (`5c724c6`), plus the forged commit `adc0081`.                              |
| 2026-10-17 18:11–18:22 | #325, #324, #326, #323 and #327 merged into the old `master` branch. #325 introduced the payload.                           |
| 2026-10-17 18:26       | #332 squash-merged `master` into `main`, carrying the payload with it.                                                      |
| 2026-10-17             | Payload found during local verification; investigation confirms the forged commit and that no merged version could execute. |
| 2026-10-18 16:13       | #336 removes the payload block from `eslint.config.mjs`.                                                                    |
| 2026-10-18             | Drips reports the repository as affected and removes it from Wave as a precaution.                                          |
| 2026-10-18             | Cleanup pull request removes the remaining traces and adds the CI gate below.                                               |

## Root cause and contributing conditions

- **Root cause:** a contributor's machine infected by PolinRider, which injected
  its payload into the branches they pushed.
- **Merges bypassed CI.** At the time, `main` required no status checks and
  administrators could merge past failing ones. The first infected PR reached
  `main` through a branch merged without its checks passing.
- **Review did not catch it.** A documentation PR (#325) also changed
  `eslint.config.mjs` and `.gitignore`. The payload sat past the visible width
  of an editor and of GitHub's diff view.
- **The repository had no automated check** for this campaign's known signs.

## Containment and recovery

- Payload removed from `eslint.config.mjs` (#336). The leftover `createRequire`
  import and `require` binding, which existed only to serve the payload, and
  the three `.gitignore` entries were removed in the cleanup PR.
- Every branch and every open and recent pull request head was scanned for all
  indicators in the Drips advisory. The infected branch `revert-325-fix/issue-161`
  (PR #333, which never merged) is closed and deleted.
- The same cleanup repaired unrelated merge damage from the 2026-10-18 batch of
  merges, which had left `main` unable to install or lint: a broken
  `pnpm-lock.yaml` (duplicate keys, and workspace settings dropped by #337), a
  duplicated dependency block in `apps/api/package.json`, and an unclosed block
  in `eslint.config.mjs`.

## Prevention

- **`infra/ci/check-malware-indicators.mjs`** runs first in CI, before install
  and lint, and fails on the campaign's code markers, dropper file names,
  `dist/setup.js`, font files, VS Code folder-open tasks, install lifecycle
  scripts, known-malicious packages, `.gitignore` entries hiding `.bat` files,
  and config files with hidden whitespace or extremely long lines. It fails on
  both the infected `main` and the original #325 branch. Run it locally with
  `pnpm check:malware`.
- **`CODEOWNERS`** now names every path that runs code without being invoked
  directly — `.vscode/`, `.devcontainer/`, `.husky/`, `.github/`, `infra/ci/`,
  every `package.json`, the lockfile and workspace file, `.gitignore`, `*.config.*`
  files, fonts and scripts — so maintainer review of those changes is required.
- **Branch protection on `main`:** required status checks restored, including
  the gate above; administrators no longer able to bypass them; an approving
  review from a code owner required.

## Follow-up actions

- Contributors with open pull requests rebase onto the cleaned `main`; branches
  created before the cleanup are re-scanned before merge.
- Consider requiring signed commits once contributors have signing set up.
- Re-run the full-history scan periodically; the CI gate covers every new change.
