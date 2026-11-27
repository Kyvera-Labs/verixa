import { createId, Result } from "@verixa/shared-kernel";
import { describe, expect, it } from "vitest";

import { ProviderCheckResult } from "../../../application/dtos/provider-check-result.js";
import type { VerificationProvider } from "../../../application/ports/verification-provider.js";
import { Evidence } from "../../../domain/entities/evidence.js";
import { VerificationType } from "../../../domain/value-objects/verification-type.js";

/** A valid-looking (never real) artifact: a 64-hex checksum and an opaque storage key. */
function makeEvidence(verificationType: string, evidenceType: string): Evidence {
  const type = VerificationType.create(verificationType);
  if (Result.isErr(type)) {
    throw new Error("contract fixture setup failed: unknown verification type");
  }

  const evidence = Evidence.attach({
    requestId: createId<"VerificationRequestId">(),
    verificationType: type.value,
    evidenceType,
    storageRef: `evidence/${createId<"EvidenceId">()}`,
    checksum: "a".repeat(64),
  });
  if (Result.isErr(evidence)) {
    throw new Error(`contract fixture setup failed: ${evidence.error.message}`);
  }
  return evidence.value;
}

/**
 * Behavioural contract for every `VerificationProvider`, run against `ManualReviewProvider` and any
 * vendor adapter (see docs/guides/testing.md). It checks shape and invariants, not a particular
 * verdict: results are well-formed, document and liveness checks are both answerable, and neither
 * throws when the provider cannot judge.
 */
export function verificationProviderContract(createProvider: () => VerificationProvider): void {
  describe("VerificationProvider contract", () => {
    function expectWellFormed(result: ProviderCheckResult): void {
      expect(ProviderCheckResult.isValid(result)).toBe(true);
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(1);
      // A passed/failed verdict with no provider reference is suspicious
      // enough to assert against: it means the adapter manufactured an
      // outcome without a vendor record behind it. `inconclusive` may
      // legitimately have none — the manual provider called nobody.
      if (result.outcome !== "inconclusive") {
        expect(result.providerRawRef).toBeTruthy();
      }
    }

    it("answers a document check with a well-formed normalized result", async () => {
      const provider = createProvider();

      const result = await provider.checkDocument(
        makeEvidence("identity-document", "government-id-front"),
      );

      expectWellFormed(result);
    });

    it("answers a liveness check with a well-formed normalized result", async () => {
      const provider = createProvider();

      const result = await provider.checkLiveness(makeEvidence("liveness", "selfie"));

      expectWellFormed(result);
    });

    it("answers both check kinds for every evidence type it may be handed", async () => {
      const provider = createProvider();

      const documentResults = await Promise.all([
        provider.checkDocument(makeEvidence("identity-document", "government-id-front")),
        provider.checkDocument(makeEvidence("identity-document", "government-id-back")),
        provider.checkDocument(makeEvidence("address", "proof-of-address")),
      ]);

      for (const result of documentResults) {
        expectWellFormed(result);
      }
    });
  });
}
