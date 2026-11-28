import { asId } from "@verixa/shared-kernel";
import type { ReviewerId, VerificationRequest, VerificationTypeValue } from "@verixa/verification";

import {
  makeVerificationRequest,
  type VerificationRequestFactoryOptions,
} from "../factories/verification-request.js";

import { orThrowDomainError } from "./domain-result.js";

type VerificationRequestStep = (request: VerificationRequest, now: Date) => VerificationRequest;

const DEFAULT_DECISION_NOTE = "Decided by testing-kit builder.";

/**
 * Fluent, immutable builder for `VerificationRequest`. Starts from {@link makeVerificationRequest}
 * (`pending_evidence`) and replays each call as a real transition (`submit()`, `startReview()`,
 * `claimBy()`, `approve()`), so results are always valid and an out-of-order chain throws
 * `InvalidStatusTransitionError` or `ReviewDecisionNotPermittedError` at `build()`.
 */
export class VerificationRequestBuilder {
  private constructor(
    private readonly options: VerificationRequestFactoryOptions,
    private readonly steps: readonly VerificationRequestStep[],
  ) {}

  /** Entry point: a fresh `identity-document` request awaiting evidence. */
  static create(): VerificationRequestBuilder {
    return new VerificationRequestBuilder({}, []);
  }

  /** The user being verified. */
  forSubject(subjectUserId: string): VerificationRequestBuilder {
    return this.withOptions({ subjectUserId });
  }

  /** The tenant the request belongs to. */
  inOrganization(organizationId: string): VerificationRequestBuilder {
    return this.withOptions({ organizationId });
  }

  /** What is being verified: `identity-document`, `address`, or `liveness`. */
  ofType(type: VerificationTypeValue): VerificationRequestBuilder {
    return this.withOptions({ type });
  }

  /** `pending_evidence → submitted`: the subject has supplied every required piece of evidence. */
  submitted(): VerificationRequestBuilder {
    return this.withStep((request) => orThrowDomainError(request.submit()));
  }

  /** `pending_evidence → submitted → in_review`: the usual precondition for any reviewer action. */
  inReview(): VerificationRequestBuilder {
    return this.withStep((request) =>
      orThrowDomainError(orThrowDomainError(request.submit()).startReview()),
    );
  }

  /** A reviewer holds the (time-limited) claim on an `in_review` request. */
  claimedBy(reviewerId: string): VerificationRequestBuilder {
    return this.withStep((request, now) =>
      orThrowDomainError(request.claimBy({ reviewerId: reviewer(reviewerId), now })),
    );
  }

  /** The claim holder approved it. Terminal. */
  approvedBy(reviewerId: string, note: string = DEFAULT_DECISION_NOTE): VerificationRequestBuilder {
    return this.withStep((request, now) =>
      orThrowDomainError(request.approve({ reviewerId: reviewer(reviewerId), note, now })),
    );
  }

  /** The claim holder rejected it. Terminal. */
  rejectedBy(reviewerId: string, note: string = DEFAULT_DECISION_NOTE): VerificationRequestBuilder {
    return this.withStep((request, now) =>
      orThrowDomainError(request.reject({ reviewerId: reviewer(reviewerId), note, now })),
    );
  }

  /** The claim holder sent it back to the subject with a note on what is missing. */
  awaitingMoreInformationFrom(reviewerId: string, note: string): VerificationRequestBuilder {
    return this.withStep((request, now) =>
      orThrowDomainError(
        request.requestMoreInformation({ reviewerId: reviewer(reviewerId), note, now }),
      ),
    );
  }

  /** Builds a fresh, domain-valid `VerificationRequest` by replaying the chain through the aggregate. */
  build(now: Date = new Date()): VerificationRequest {
    const initial = makeVerificationRequest(this.options);
    return this.steps.reduce((request, step) => step(request, now), initial);
  }

  private withOptions(options: VerificationRequestFactoryOptions): VerificationRequestBuilder {
    return new VerificationRequestBuilder({ ...this.options, ...options }, this.steps);
  }

  private withStep(step: VerificationRequestStep): VerificationRequestBuilder {
    return new VerificationRequestBuilder(this.options, [...this.steps, step]);
  }
}

function reviewer(id: string): ReviewerId {
  return asId<"ReviewerId">(id);
}

/** `aVerificationRequest().inReview().claimedBy('rev_1').approvedBy('rev_1').build()` */
export function aVerificationRequest(): VerificationRequestBuilder {
  return VerificationRequestBuilder.create();
}
