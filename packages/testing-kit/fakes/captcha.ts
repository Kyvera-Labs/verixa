import type { ResettableFake } from "./fake-contract.js";

export interface CaptchaValidator {
  verify(token: string): Promise<boolean>;
}

/**
 * Standardized in-memory CAPTCHA validator satisfying the `InMemory<Port>` naming convention.
 * Replaces ad-hoc no-op captcha test doubles.
 */
export class InMemoryCaptchaValidator implements CaptchaValidator, ResettableFake {
  private allowedTokens = new Set<string>();
  private defaultResponse = true;

  constructor(defaultResponse: boolean = true) {
    this.defaultResponse = defaultResponse;
  }

  verify(token: string): Promise<boolean> {
    if (this.allowedTokens.has(token)) {
      return Promise.resolve(true);
    }
    return Promise.resolve(this.defaultResponse);
  }

  allowToken(token: string): void {
    this.allowedTokens.add(token);
  }

  setDefaultResponse(allowed: boolean): void {
    this.defaultResponse = allowed;
  }

  reset(): void {
    this.allowedTokens.clear();
    this.defaultResponse = true;
  }

  clear(): void {
    this.reset();
  }
}

/** No-op alias for backwards-compatibility or concise instantiation */
export const NoopCaptchaValidator = InMemoryCaptchaValidator;
