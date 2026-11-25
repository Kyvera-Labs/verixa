import type {
  RetentionActionLog,
  RetentionActionRecord,
} from "../application/ports/retention-ports.js";
import type { RetentionAction } from "../domain/retention-rule.js";

/** Process-local action log, for tests and single-process development. */
export class InMemoryRetentionActionLog implements RetentionActionLog {
  private readonly entries: RetentionActionRecord[] = [];

  append(record: RetentionActionRecord): Promise<void> {
    this.entries.push(record);
    return Promise.resolve();
  }

  wasCompleted(ruleId: string, resourceId: string, action: RetentionAction): Promise<boolean> {
    return Promise.resolve(
      this.entries.some(
        (e) =>
          e.ruleId === ruleId &&
          e.resourceId === resourceId &&
          e.action === action &&
          (e.outcome === "applied" || e.outcome === "already_applied"),
      ),
    );
  }

  /** Everything recorded, oldest first. */
  all(): readonly RetentionActionRecord[] {
    return [...this.entries];
  }
}
