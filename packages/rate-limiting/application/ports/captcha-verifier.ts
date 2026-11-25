import { DomainError, type Result } from "@verixa/shared-kernel";

/**
 * Base error type for CAPTCHA verification failures.
 */
export abstract class CaptchaError extends DomainError {}

/**
 * The submitted CAPTCHA response token was missing, expired, or rejected
 * by the validation service as invalid.
 */
export class InvalidCaptchaTokenError extends CaptchaError {
  readonly code = "INVALID_CAPTCHA_TOKEN";
  readonly httpStatusHint = 400;

  constructor(message = "CAPTCHA token verification failed") {
    super(message);
  }
}

/**
 * The external CAPTCHA verification service timed out before responding.
 */
export class CaptchaTimeoutError extends CaptchaError {
  readonly code = "CAPTCHA_TIMEOUT";
  readonly httpStatusHint = 504;

  constructor(message = "CAPTCHA verification service timed out") {
    super(message);
  }
}

/**
 * The CAPTCHA verification service returned an unparseable or unexpected response body.
 */
export class MalformedCaptchaResponseError extends CaptchaError {
  readonly code = "CAPTCHA_MALFORMED_RESPONSE";
  readonly httpStatusHint = 502;

  constructor(message = "CAPTCHA service returned a malformed response") {
    super(message);
  }
}

/**
 * The external CAPTCHA provider was unreachable or returned an upstream server error (5xx).
 */
export class CaptchaServiceError extends CaptchaError {
  readonly code = "CAPTCHA_SERVICE_UNAVAILABLE";
  readonly httpStatusHint = 503;

  constructor(message = "CAPTCHA verification service is currently unavailable") {
    super(message);
  }
}

/**
 * Port for third-party human-verification challenge checks (e.g., hCaptcha, reCAPTCHA, Turnstile).
 *
 * Provides a vendor-neutral seam for verifying challenge response tokens submitted by clients.
 * Allows switching between development stubs (no-op) and production vendor adapters without
 * coupling application use cases to vendor SDKs or network protocols.
 *
 * Method contracts:
 * - `verify` returns `Result.ok(undefined)` when the challenge token is confirmed valid.
 * - Expected verification failures (token expired, rejected by vendor, malformed token)
 *   return an `InvalidCaptchaTokenError`.
 * - Upstream failures (network timeout, unreachable endpoint, malformed vendor response)
 *   return specific `CaptchaError` subclasses (`CaptchaTimeoutError`, `CaptchaServiceError`,
 *   `MalformedCaptchaResponseError`) rather than throwing, allowing callers to apply fallback
 *   policies or retry strategies safely.
 */
export interface CaptchaVerifier {
  /**
   * Validates a client-submitted CAPTCHA response token.
   *
   * @param token Client-provided response token from the challenge widget
   * @returns Result indicating success (`void`) or a specific `CaptchaError` failure
   */
  verify(token: string): Promise<Result<void, CaptchaError>>;
}
