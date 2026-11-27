import type { Rule, PolicySet } from "../../domain/entities/rule.js";
import type { ComparisonCondition, Condition } from "../../domain/value-objects/condition.js";

/**
 * One flattened equality/inequality constraint pulled out of a rule's
 * condition tree, e.g. `subject.role equals "admin"`.
 *
 * Only `equals`/`notEquals` are represented — see {@link extractConstraints}
 * for why the other operators, and non-conjunctive conditions, are excluded
 * rather than approximated.
 */
interface Constraint {
  readonly attribute: string;
  readonly operator: "equals" | "notEquals";
  readonly value: unknown;
}

/**
 * Flattens a condition into {@link Constraint}s if it is a conjunction (top-level `AND`, or a
 * single leaf) of `equals`/`notEquals` comparisons; returns `null` otherwise. Overlap between
 * arbitrary condition trees is a satisfiability problem, so anything wider is skipped rather than
 * approximated, and the linter never reports a finding it cannot prove.
 */
function extractConstraints(condition: Condition): readonly Constraint[] | null {
  if (condition.kind === "comparison") {
    return extractLeafConstraint(condition);
  }

  if (condition.kind === "and") {
    const constraints: Constraint[] = [];
    for (const child of condition.operands) {
      const childConstraints = extractConstraints(child);
      if (childConstraints === null) return null;
      constraints.push(...childConstraints);
    }
    return constraints;
  }

  // `always`, `or`, and `not` conditions are not conjunctions of equality
  // comparisons and are deliberately left unanalyzed. `always` in particular
  // is not a missing case: a rule that always matches is exactly as broad as
  // a conjunction of zero constraints would be, but representing that as
  // `[]` here would make it compatible with (and implied by) everything,
  // which is correct for `implies` but wrong for `overlaps` -- an `always`
  // DENY and *any* PERMIT rule do overlap, which is worth a finding, not a
  // silent pass. Treating it as unanalyzed is the conservative choice this
  // linter makes everywhere else it cannot prove something cheaply.
  return null;
}

/**
 * The comparison operators this linter understands as equality or its
 * negation. `Condition`'s `ComparisonOperator` has others (`lt`, `in`,
 * `contains`, ...); a leaf using any of those is left unanalyzed for the same
 * reason `OR` and `NOT` are -- `implies`/`overlaps` below only know how to
 * reason about equals/not-equals.
 */
function extractLeafConstraint(condition: ComparisonCondition): readonly Constraint[] | null {
  if (condition.operator !== "eq" && condition.operator !== "neq") return null;
  const operator = condition.operator === "eq" ? "equals" : "notEquals";
  return [{ attribute: condition.attribute, operator, value: condition.value }];
}

/**
 * Whether every context satisfying `narrower` also satisfies `broader`: every constraint in
 * `broader` must also appear in `narrower`.
 */
function implies(broader: readonly Constraint[], narrower: readonly Constraint[]): boolean {
  return broader.every((requirement) =>
    narrower.some(
      (other) =>
        other.attribute === requirement.attribute &&
        other.operator === requirement.operator &&
        other.value === requirement.value,
    ),
  );
}

/**
 * Whether two constraint sets can both hold. They conflict when one attribute must equal different
 * values, or must both equal and not equal the same value.
 */
function overlaps(a: readonly Constraint[], b: readonly Constraint[]): boolean {
  for (const left of a) {
    for (const right of b) {
      if (left.attribute !== right.attribute) continue;

      if (left.operator === "equals" && right.operator === "equals") {
        if (left.value !== right.value) return false;
      } else if (left.operator === "notEquals" && right.operator === "notEquals") {
        // Two different exclusions on the same attribute are compatible
        // (a context can satisfy both by avoiding both values); identical
        // ones are trivially compatible too.
        continue;
      } else {
        // One equals, one notEquals, on the same attribute: incompatible
        // only if they name the same value.
        const equalsConstraint = left.operator === "equals" ? left : right;
        const notEqualsConstraint = left.operator === "equals" ? right : left;
        if (equalsConstraint.value === notEqualsConstraint.value) return false;
      }
    }
  }

  return true;
}

export type LinterFindingType = "conflict" | "shadow";

export interface LinterFinding {
  readonly type: LinterFindingType;
  /** The rules involved, in policy-set order. */
  readonly ruleIds: readonly [string, string];
  readonly message: string;
}

export interface LintResult {
  readonly findings: readonly LinterFinding[];
  /**
   * How many rule pairs could not be analyzed because at least one side's
   * condition fell outside the conjunction-of-equalities shape
   * {@link extractConstraints} handles. Surfaced explicitly (rather than
   * silently treated as "no finding") so a consumer of this linter's output
   * can tell "checked and clean" apart from "not actually checked" — the
   * documented false-negative tradeoff from `docs/guides/tools/policy-linting.md`.
   */
  readonly unanalyzedPairs: number;
}

/**
 * Lints a policy set's rules under `first-applicable` order for two mistakes:
 *
 * - **conflict**: a `PERMIT` and a `DENY` rule that some request could match together.
 * - **shadow**: an earlier rule at least as broad as a later one, making the later rule
 *   unreachable.
 *
 * Only conditions that are conjunctions of `equals`/`notEquals` comparisons are analysed (see
 * {@link extractConstraints}). Other pairs are counted in {@link LintResult.unanalyzedPairs}, so
 * there are no false positives, at the cost of some false negatives (see
 * docs/guides/tools/policy-linting.md).
 */
interface AnalyzedRule {
  readonly rule: Rule;
  readonly constraints: readonly Constraint[] | null;
}

export function lintPolicySet(policySet: PolicySet): LintResult {
  const findings: LinterFinding[] = [];
  let unanalyzedPairs = 0;

  // Analyzed once per rule up front — walking the whole policy set is O(n)
  // and the result (each rule's flattened constraints, or `null`) is reused
  // for every pair that rule appears in, rather than re-extracted for every
  // pair. Iterating pairs via `.entries()`/`.slice()` below (instead of
  // indexing `rules[i]`) keeps the loop free of numeric array indexing.
  const analyzed: AnalyzedRule[] = policySet.rules.map((rule) => ({
    rule,
    constraints: extractConstraints(rule.condition),
  }));

  for (const [position, earlier] of analyzed.entries()) {
    for (const later of analyzed.slice(position + 1)) {
      if (earlier.constraints === null || later.constraints === null) {
        unanalyzedPairs += 1;
        continue;
      }

      if (
        earlier.rule.effect !== later.rule.effect &&
        overlaps(earlier.constraints, later.constraints)
      ) {
        findings.push({
          type: "conflict",
          ruleIds: [earlier.rule.id, later.rule.id],
          message:
            `Rule "${earlier.rule.id}" (${earlier.rule.effect}) and rule "${later.rule.id}" ` +
            `(${later.rule.effect}) have overlapping conditions: some request could satisfy both, ` +
            "but they disagree on the effect.",
        });
      }

      if (implies(earlier.constraints, later.constraints)) {
        findings.push({
          type: "shadow",
          ruleIds: [earlier.rule.id, later.rule.id],
          message:
            `Rule "${earlier.rule.id}" is broader than (or equal to) rule "${later.rule.id}" and ` +
            `comes first, so rule "${later.rule.id}" can never be reached under first-applicable.`,
        });
      }
    }
  }

  return { findings, unanalyzedPairs };
}
