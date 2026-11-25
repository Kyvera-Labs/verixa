import { Result } from "@verixa/shared-kernel";

import {
  type CaptchaError,
  type CaptchaVerifier,
  CaptchaServiceError,
  CaptchaTimeoutError,
  InvalidCaptchaTokenError,
  MalformedCaptchaResponseError,
} from "../../application/ports/captcha-verifier.js";

export interface NoopCaptchaVerifierOptions {
  /** Simulated failure mode for testing error handling. */
  readonly simulatedFailure?: "invalid" | "timeout" | "malformed" | "service_error" | undefined;
}

/**
 * In-memory / development adapter for CAPTCHA verification.
 *
 * Always approves verification by default in development and test environments,
 * removing the need for network access or external vendor credentials during local development.
 * Supports configurable simulation modes to test caller reaction to error conditions.
 */
export class NoopCaptchaVerifier implements CaptchaVerifier {
  constructor(private readonly options: NoopCaptchaVerifierOptions = {}) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async verify(token: string): Promise<Result<void, CaptchaError>> {
    if (this.options.simulatedFailure === "timeout") {
      return Result.err(new CaptchaTimeoutError());
    }

    if (this.options.simulatedFailure === "malformed") {
      return Result.err(new MalformedCaptchaResponseError());
    }

    if (this.options.simulatedFailure === "service_error") {
      return Result.err(new CaptchaServiceError());
    }

    if (this.options.simulatedFailure === "invalid" || token === "invalid-token" || !token.trim()) {
      return Result.err(new InvalidCaptchaTokenError("Invalid or empty CAPTCHA token"));
    }

    return Result.ok(undefined);
  }
}
