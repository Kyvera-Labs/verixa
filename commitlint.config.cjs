module.exports = {
  extends: ["@commitlint/config-conventional"],
  // Dependabot writes release notes into the commit body, with lines over the
  // 100-character body limit, so every grouped update failed the required
  // commitlint check. Its subjects already follow the prefixes set in
  // .github/dependabot.yml. Matching the sign-off it adds skips only its own
  // commits; everyone else's are still checked in full.
  ignores: [(message) => /^Signed-off-by: dependabot\[bot\] <support@github\.com>$/m.test(message)],
};
