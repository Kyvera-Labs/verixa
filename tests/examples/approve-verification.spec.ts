/**
 * The unit-test example from docs/guides/tutorials/testing-the-platform.md.
 * The tutorial imports the `#region` blocks below instead of
 * copying them, so this file is the example: if it stops compiling or passing,
 * `pnpm test` fails, and if a region is renamed, `pnpm docs:build` fails.
 *
 * It lives in `tests/` rather than next to `ApproveVerification` in
 * packages/verification because `@verixa/testing-kit` depends on every context
 * package. A context package depending back on testing-kit would be a
 * dependency cycle, so the builders and the fake registry are for consumers
 * outside the contexts. The test itself is an ordinary unit test: one use case,
 * an in-memory fake, no I/O.
 */

// #region unit-test
import { Result, asId } from "@verixa/shared-kernel";
import {
  aVerificationRequest,
  FixedClock,
  InMemoryVerificationRequestRepository,
} from "@verixa/testing-kit";
import { ApproveVerification, ReviewDecisionNotPermittedError } from "@verixa/verification";
import { describe, expect, it } from "vitest";

const clock = new FixedClock(new Date("2026-09-28T12:00:00.000Z"));

describe("ApproveVerification", () => {
  it("approves a request the reviewer has claimed and persists the decision", async () => {
    // Arrange: the chain is the precondition, replayed through the aggregate.
    const request = aVerificationRequest()
      .ofType("address")
      .inReview()
      .claimedBy("rev_alice")
      .build(clock.now());
    const requests = new InMemoryVerificationRequestRepository();
    await requests.save(request);

    // Act
    const result = await new ApproveVerification(requests).execute({
      requestId: request.id,
      reviewerId: asId<"ReviewerId">("rev_alice"),
      note: "Utility bill matches the declared address.",
      now: clock.now(),
    });

    // Assert: on what the caller and the repository observe, not on internals.
    expect(Result.isOk(result)).toBe(true);
    const persisted = await requests.findById(request.id);
    expect(persisted?.status.value).toBe("approved");
    expect(persisted?.decision?.decidedBy).toBe("rev_alice");
  });

  it("refuses a reviewer who does not hold the claim", async () => {
    const request = aVerificationRequest().inReview().claimedBy("rev_alice").build(clock.now());
    const requests = new InMemoryVerificationRequestRepository();
    await requests.save(request);

    const result = await new ApproveVerification(requests).execute({
      requestId: request.id,
      reviewerId: asId<"ReviewerId">("rev_mallory"),
      note: "Looks fine to me.",
      now: clock.now(),
    });

    expect(Result.isErr(result) && result.error).toBeInstanceOf(ReviewDecisionNotPermittedError);
  });
});
// #endregion unit-test
