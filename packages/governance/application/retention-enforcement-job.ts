import { isActionPermitted, type RetentionRule } from "../domain/retention-rule.js";

import type { RetentionActionLog, RetentionRuleSource } from "./ports/retention-ports.js";
import type { RetentionTarget } from "./ports/retention-target.js";

export interface RetentionRunSummary {
  readonly rulesEvaluated: number;
  readonly applied: number;
  readonly alreadyApplied: number;
  /** Skipped because the log already shows the action completed. */
  readonly skipped: number;
  readonly refused: number;
  readonly failed: number;
}

export interface RetentionEnforcementJobOptions {
  /** Records handled per batch. Default 100. */
  readonly batchSize?: number;
  /** Upper bound on batches per rule per run, so one run always ends. Default 100. */
  readonly maxBatchesPerRule?: number;
}

/**
 * Applies each active retention rule to the records its context reports as
 * past retention.
 *
 * Designed to be run on a schedule and to be re-run at any time, including
 * after a crash halfway through a batch. That is the same at-least-once
 * reasoning as any queue consumer: assume every step can happen twice and make
 * the second time harmless. Two things provide that:
 *
 * 1. `RetentionTarget.apply` is idempotent, so applying an action twice is a
 *    no-op the second time. This covers the unavoidable window between "the
 *    record was changed" and "the job logged it".
 * 2. The job consults the log first and skips what already completed, so a
 *    re-run does not even call the target for finished work.
 *
 * Alternative rejected: a run lock plus "mark progress, then act". It makes
 * crash recovery depend on cleaning up the lock and the marker; idempotent
 * actions need no cleanup.
 *
 * Governance never touches another context's data. It talks to targets only.
 */
export class RetentionEnforcementJob {
  private readonly batchSize: number;
  private readonly maxBatchesPerRule: number;

  constructor(
    private readonly rules: RetentionRuleSource,
    private readonly targets: readonly RetentionTarget[],
    private readonly log: RetentionActionLog,
    options: RetentionEnforcementJobOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.maxBatchesPerRule = options.maxBatchesPerRule ?? 100;
  }

  async run(now: Date = new Date()): Promise<RetentionRunSummary> {
    const counts = { applied: 0, alreadyApplied: 0, skipped: 0, refused: 0, failed: 0 };
    const rules = await this.rules.listActiveRules();

    for (const rule of rules) {
      await this.enforce(rule, now, counts);
    }
    return { rulesEvaluated: rules.length, ...counts };
  }

  private async enforce(
    rule: RetentionRule,
    now: Date,
    counts: {
      applied: number;
      alreadyApplied: number;
      skipped: number;
      refused: number;
      failed: number;
    },
  ): Promise<void> {
    const refuse = async (detail: string): Promise<void> => {
      counts.refused += 1;
      await this.log.append({
        ruleId: rule.id,
        organizationId: rule.organizationId,
        resourceType: rule.resourceType,
        resourceId: "*",
        action: rule.action,
        outcome: "refused",
        occurredAt: now,
        detail,
      });
    };

    // Checked again here even though rule creation already enforces it: a rule
    // reconstituted from storage skips creation, and the guarantee that audit
    // data is never deleted must not depend on how a rule got here.
    if (!isActionPermitted(rule.resourceType, rule.action)) {
      await refuse(`action "${rule.action}" is not permitted for ${rule.resourceType}`);
      return;
    }
    const target = this.targets.find((t) => t.resourceType === rule.resourceType);
    if (target === undefined) {
      await refuse(`no retention target is registered for ${rule.resourceType}`);
      return;
    }
    if (!target.supportedActions.includes(rule.action)) {
      await refuse(`target for ${rule.resourceType} does not support "${rule.action}"`);
      return;
    }

    const cutoff = rule.cutoffAt(now);
    for (let batch = 0; batch < this.maxBatchesPerRule; batch += 1) {
      const expired = await target.findExpired({
        organizationId: rule.organizationId,
        action: rule.action,
        cutoff,
        limit: this.batchSize,
      });
      if (expired.length === 0) return;

      let progressed = false;
      for (const { resourceId } of expired) {
        if (await this.log.wasCompleted(rule.id, resourceId, rule.action)) {
          counts.skipped += 1;
          progressed = true;
          continue;
        }
        try {
          const outcome = await target.apply(rule.organizationId, resourceId, rule.action);
          await this.log.append({
            ruleId: rule.id,
            organizationId: rule.organizationId,
            resourceType: rule.resourceType,
            resourceId,
            action: rule.action,
            outcome,
            occurredAt: now,
          });
          if (outcome === "applied") counts.applied += 1;
          else counts.alreadyApplied += 1;
          progressed = true;
        } catch (error) {
          counts.failed += 1;
          await this.log.append({
            ruleId: rule.id,
            organizationId: rule.organizationId,
            resourceType: rule.resourceType,
            resourceId,
            action: rule.action,
            outcome: "failed",
            occurredAt: now,
            detail: error instanceof Error ? error.message : "unknown error",
          });
        }
      }

      // A batch where nothing moved would be returned again forever; stop and
      // let the next scheduled run retry the failures.
      if (!progressed || expired.length < this.batchSize) return;
    }
  }
}
