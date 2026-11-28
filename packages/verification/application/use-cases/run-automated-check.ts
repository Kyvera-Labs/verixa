import { NotFoundError, Result, ValidationError } from "@verixa/shared-kernel";

import type { Evidence, EvidenceId } from "../../domain/entities/evidence.js";
import type {
  VerificationRequest,
  VerificationRequestId,
} from "../../domain/entities/verification-request.js";
import type { InvalidStatusTransitionError } from "../../domain/errors/invalid-status-transition.js";
import { ProviderCheckResult } from "../dtos/provider-check-result.js";
import type { VerificationProvider } from "../ports/verification-provider.js";
import type { VerificationRequestRepository } from "../ports/verification-request-repository.js";

export interface RunAutomatedCheckCommand {
  readonly requestId: VerificationRequestId;
  /**
   * The evidence to check. Supplied by the caller rather than fetched here:
   * this package has no `EvidenceRepository` yet (evidence persistence
   * is not built yet), and the upload flow that triggers an automated check
   * already has the evidence it just accepted in hand.
   */
  readonly evidence: readonly Evidence[];
}

export interface EvidenceCheckOutcome {
  readonly evidenceId: EvidenceId;
  readonly result: ProviderCheckResult;
}

export interface RunAutomatedCheckResult {
  readonly request: VerificationRequest;
  /** One result per evidence item, in the order `evidence` was given. */
  readonly checkResults: readonly EvidenceCheckOutcome[];
}

export type RunAutomatedCheckError = ValidationError | NotFoundError | InvalidStatusTransitionError;

/**
 * Runs the configured {@link VerificationProvider} on a submitted request's evidence and moves the
 * case to `in_review` whatever the outcome. Providers never decide; only a human reviewer reaches a
 * terminal state. A provider error is treated like `inconclusive` so the request does not get
 * stuck. Results are returned to the caller, not stored on the aggregate (see
 * docs/guides/verification-provider-integration.md).
 */
export class RunAutomatedCheck {
  constructor(
    private readonly requests: VerificationRequestRepository,
    private readonly provider: VerificationProvider,
  ) {}

  async execute(
    command: RunAutomatedCheckCommand,
  ): Promise<Result<RunAutomatedCheckResult, RunAutomatedCheckError>> {
    const request = await this.requests.findById(command.requestId);
    if (request === undefined) {
      return Result.err(
        new NotFoundError(`Verification request ${command.requestId} was not found.`),
      );
    }

    for (const item of command.evidence) {
      if (!item.belongsTo(request.id)) {
        return Result.err(
          new ValidationError("Evidence does not belong to this verification request.", {
            evidence: ["mismatched_request"],
          }),
        );
      }
    }

    const checkResults: EvidenceCheckOutcome[] = [];
    for (const item of command.evidence) {
      checkResults.push({ evidenceId: item.id, result: await this.check(item) });
    }

    const reviewed = request.startReview();
    if (Result.isErr(reviewed)) {
      return reviewed;
    }

    await this.requests.save(reviewed.value);

    return Result.ok({ request: reviewed.value, checkResults });
  }

  private async check(evidence: Evidence): Promise<ProviderCheckResult> {
    try {
      const result =
        evidence.typeValue === "selfie"
          ? await this.provider.checkLiveness(evidence)
          : await this.provider.checkDocument(evidence);
      return ProviderCheckResult.isValid(result) ? result : ProviderCheckResult.inconclusive();
    } catch {
      // The check itself could not be completed (network failure,
      // misconfiguration) — not an answer the provider gave. Still routes
      // to a human, same as a vendor that honestly says "inconclusive".
      return ProviderCheckResult.inconclusive();
    }
  }
}
