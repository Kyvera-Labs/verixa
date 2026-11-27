/**
 * The effect a matching {@link Rule} contributes. Not a boolean, so "denies" stays distinguishable
 * from "does not apply" (`NOT_APPLICABLE`).
 */
export type Effect = "PERMIT" | "DENY";
