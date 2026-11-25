import { Result } from "@verixa/shared-kernel";

import {
  type CaptchaError,
  type CaptchaVerifier,
  CaptchaServiceError,
  CaptchaTimeoutError,
  InvalidCaptchaTokenError,
  MalformedCaptchaResponseError,
} from "../../application/ports/captcha-verifier.js";

export interface HttpCaptchaVerifierConfig {
  readonly secretKey: string;
  readonly verifyUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injectable fetch function for isolation and testing. */
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * HTTP adapter for CAPTCHA verification services (e.g. hCaptcha, Turnstile, reCAPTCHA).
 *
 * Dispatches a POST verification request to the vendor siteverify endpoint with the
 * secret key and user-submitted token, enforcing an explicit timeout and translating
 * network, server, and payload errors into domain Result errors.
 */
export class HttpCaptchaVerifier implements CaptchaVerifier {
  private readonly secretKey: string;
  private readonly verifyUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: HttpCaptchaVerifierConfig) {
    this.secretKey = config.secretKey;
    this.verifyUrl = config.verifyUrl ?? "https://api.hcaptcha.com/siteverify";
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async verify(token: string): Promise<Result<void, CaptchaError>> {
    if (!token || !token.trim()) {
      return Result.err(new InvalidCaptchaTokenError("CAPTCHA token must not be empty"));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchFn(this.verifyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: this.secretKey,
          response: token,
        }).toString(),
        signal: controller.signal,
      });

      if (response.status >= 500) {
        return Result.err(
          new CaptchaServiceError(`Upstream CAPTCHA service returned status ${response.status}`),
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return Result.err(new MalformedCaptchaResponseError("Failed to parse JSON response body"));
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        typeof (payload as { success?: unknown }).success !== "boolean"
      ) {
        return Result.err(
          new MalformedCaptchaResponseError("Response missing boolean success field"),
        );
      }

      const { success } = payload as { success: boolean };
      if (!success) {
        return Result.err(
          new InvalidCaptchaTokenError("Verification rejected by CAPTCHA provider"),
        );
      }

      return Result.ok(undefined);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return Result.err(new CaptchaTimeoutError(`Request exceeded ${this.timeoutMs}ms timeout`));
      }

      return Result.err(
        new CaptchaServiceError(
          err instanceof Error ? err.message : "Network error contacting CAPTCHA provider",
        ),
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
