// Commitlint configuration enforcing the Conventional Commits specification
// documented in docs/guides/conventional-commits.md (Issue 010).
//
// Why this matters: semantic-release (Issue 368 / .releaserc.json) derives
// major/minor/patch version bumps and CHANGELOG entries directly from commit
// headers on `main`. Both local git hooks (.husky/commit-msg) and CI
// (.github/workflows/commitlint.yml) share this exact config so PR titles
// (squash-merge commit sources) and individual commits are validated against
// one source of truth.

// One already-reviewed historical commit is exempt from linting (commitlint's
// `ignores` skips every rule for a match). Olorunfemi20's ad89fbd in #590 has
// a 104-character header and one body line over the 100-character limit. Its changes
// reached main through #652 under a shortened header, but #590 itself can
// only show as merged if this exact commit lands, and rewording it would
// make it a different commit. Matching the full header exactly exempts only
// that commit; any edit to it, and every other commit, is checked in full.
const EXEMPT_HEADERS = new Set([
  "feat(ci): add test coverage workflow, dashboards-as-code, commitlint PR-title gate, and semantic-release",
]);

module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Explicit allow-list matching Issue 010 and @commitlint/config-conventional
    // so semantic-release only ever sees machine-parseable commit types.
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
    "type-case": [2, "always", "lower-case"],
    "type-empty": [2, "never"],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 100],
  },
  // Dependabot writes release notes into the commit body, with lines over the
  // 100-character body limit, so every grouped update failed the required
  // commitlint check. Its subjects already follow the prefixes set in
  // .github/dependabot.yml. Matching the sign-off it adds skips only its own
  // commits; everyone else's are still checked in full.
  ignores: [
    (message) => /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m.test(message),
    (message) => EXEMPT_HEADERS.has(message.split("\n")[0].trim()),
  ],
};
