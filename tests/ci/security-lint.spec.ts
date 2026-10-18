/**
 * Security lint ruleset (Issue 208).
 *
 * The acceptance criterion is that every *enabled* rule is caught on a
 * deliberately vulnerable fixture — not that a config file mentions the rule.
 * So this test asks ESLint two questions, both through the same fixture config
 * the repository's `eslint.config.mjs` derives its ruleset from:
 *
 * 1. `--print-config` — which security rules are actually on, and at what
 *    severity, for a fixture file;
 * 2. `--format json` — which rules fired on the fixtures.
 *
 * Then it checks set containment: every enabled rule fired somewhere. A rule
 * added to the shared ruleset without a fixture fails here, which is the whole
 * point of the exercise — a lint rule nobody can demonstrate firing is a rule
 * that may already be broken by a plugin upgrade.
 *
 * The fixtures are also asserted to be *ignored* by the repository config, so a
 * vulnerable-on-purpose snippet can never fail `pnpm lint`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REPO_ROOT,
  SECURITY_LINT_FIXTURES,
  runSecurityLintFixtureConfig,
} from "./helpers/ci-tooling.js";

interface LintMessage {
  readonly ruleId: string | null;
}

interface LintFileResult {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
}

const DISABLED_RULES = [
  "security/detect-disable-mustache-escape",
  "security/detect-no-csrf-before-method-override",
];

function securityRulesFromConfig(): Record<string, number | [number, unknown]> {
  const result = runSecurityLintFixtureConfig([
    "--print-config",
    join(SECURITY_LINT_FIXTURES, "eval-with-expression.js"),
  ]);

  expect(result.exitCode, result.stderr).toBe(0);

  const config = JSON.parse(result.stdout) as { rules: Record<string, number | [number, unknown]> };
  const security = Object.entries(config.rules).filter(([name]) => name.startsWith("security/"));

  return Object.fromEntries(security);
}

function severityOf(value: number | [number, unknown] | undefined): number {
  if (Array.isArray(value)) return value[0];
  return value ?? 0;
}

function firedRules(): Set<string> {
  // ESLint exits non-zero when the fixtures contain errors, which is expected:
  // the fixtures are errors by design. The report on stdout is what matters.
  const result = runSecurityLintFixtureConfig([SECURITY_LINT_FIXTURES, "--format", "json"]);
  const results = JSON.parse(result.stdout) as readonly LintFileResult[];

  const fired = new Set<string>();
  for (const file of results) {
    for (const message of file.messages) {
      if (message.ruleId !== null) fired.add(message.ruleId);
    }
  }
  return fired;
}

describe("security lint ruleset", () => {
  const rules = securityRulesFromConfig();

  it("enables at least the vulnerability classes the issue names", () => {
    // Named explicitly so a future tuning pass cannot quietly drop one of the
    // targeted classes and still pass the generic containment check below.
    for (const rule of [
      "security/detect-eval-with-expression",
      "security/detect-child-process",
      "security/detect-non-literal-fs-filename",
      "security/detect-non-literal-regexp",
      "security/detect-unsafe-regex",
      "security/detect-pseudoRandomBytes",
      "security/detect-object-injection",
    ]) {
      expect(severityOf(rules[rule]), `${rule} should be enabled`).toBeGreaterThan(0);
    }
  });

  it("leaves the non-applicable rules off", () => {
    for (const rule of DISABLED_RULES) {
      expect(severityOf(rules[rule]), `${rule} should be off`).toBe(0);
    }
  });

  it("fires every enabled rule on at least one fixture", () => {
    const fired = firedRules();
    const enabled = Object.entries(rules).filter(([, value]) => severityOf(value) > 0);

    // A non-empty list keeps this from passing vacuously if the ruleset ever
    // resolves to nothing.
    expect(enabled.length).toBeGreaterThan(5);

    const unfired = enabled.map(([rule]) => rule).filter((rule) => !fired.has(rule));

    expect(unfired, "enabled rules with no fixture that triggers them").toEqual([]);
  });

  it("is the ruleset the repository config actually uses", () => {
    // A second copy of the rules inside `eslint.config.mjs` would make the
    // fixture evidence above describe the test rather than the gate.
    const config = readFileSync(join(REPO_ROOT, "eslint.config.mjs"), "utf8");

    expect(config).toContain("infra/ci/security-lint-rules.mjs");
    expect(config).toContain("securityRules");
    expect(config).not.toContain("security.configs.recommended");
  });

  it("keeps the vulnerable fixtures out of the repository lint run", () => {
    const config = readFileSync(join(REPO_ROOT, "eslint.config.mjs"), "utf8");

    expect(config).toContain('"infra/ci/lint-security-fixtures/**"');
  });
});
