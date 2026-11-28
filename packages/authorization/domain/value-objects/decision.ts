/** The effect a matching rule applies: grant or deny the request. */
export type Effect = "PERMIT" | "DENY";

/**
 * Outcome of evaluating a rule or policy set: its effect if it matched, otherwise `NOT_APPLICABLE`
 * (XACML vocabulary). "Does not apply" is distinct from "denies" so `first-applicable` combining
 * can skip non-matching rules.
 */
export type Decision = Effect | "NOT_APPLICABLE";
