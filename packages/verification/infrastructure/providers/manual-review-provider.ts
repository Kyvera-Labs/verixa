import { ProviderCheckResult } from "../../application/dtos/provider-check-result.js";
import type { VerificationProvider } from "../../application/ports/verification-provider.js";

/**
 * Default `VerificationProvider`: a null object that answers every check with `inconclusive`, so
 * every request goes to a human reviewer. It lets Verixa run end to end without a commercial
 * vendor, and serves as the reference adapter (see
 * docs/guides/verification-provider-integration.md). Returning `passed` here would auto-approve
 * every check in any deployment without a vendor.
 */
export class ManualReviewProvider implements VerificationProvider {
  /**
   * No parameter: the check is deliberately a constant, and naming an
   * argument nothing reads would suggest the result depends on it.
   */
  checkDocument(): Promise<ProviderCheckResult> {
    return Promise.resolve(ProviderCheckResult.inconclusive());
  }

  /** See {@link checkDocument} — liveness is deferred to a human for the same reason. */
  checkLiveness(): Promise<ProviderCheckResult> {
    return Promise.resolve(ProviderCheckResult.inconclusive());
  }
}
