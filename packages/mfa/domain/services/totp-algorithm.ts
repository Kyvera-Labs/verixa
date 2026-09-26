import { Result } from "@verixa/shared-kernel";
import type { TotpSecret } from "../value-objects/totp-secret.js";

export interface TotpAlgorithm {
  generateSecret(accountName: string, issuer?: string): Promise<TotpSecret>;
  
  /**
   * Verifies a 6-digit TOTP code against the given secret.
   * Tolerates a minor clock skew window.
   * 
   * Returns the matched time step if valid (to be used for replay protection),
   * or null if the code is invalid or outside the acceptable drift window.
   */
  verify(secret: TotpSecret, code: string, driftWindow?: number): Promise<number | null>;
}
