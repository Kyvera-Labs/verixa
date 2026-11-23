import { Result } from "@verixa/shared-kernel";
import { defineContractTests } from "@verixa/testing-kit";
import { describe, expect, it } from "vitest";

import {
  type CaptchaVerifier,
  CaptchaServiceError,
  CaptchaTimeoutError,
  InvalidCaptchaTokenError,
  MalformedCaptchaResponseError,
} from "../../application/ports/captcha-verifier.js";
import { HttpCaptchaVerifier } from "../adapters/http-captcha-verifier.js";
import { NoopCaptchaVerifier } from "../adapters/noop-captcha-verifier.js";

/**
 * Creates a mock fetch function tailored to simulate vendor verification responses.
 */
function createMockFetch(
  mode: "ok" | "invalid" | "timeout" | "malformed" | "server_error",
): typeof fetch {
  return (_input, init) => {
    if (mode === "timeout") {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("This operation was aborted");
            err.name = "AbortError";
            reject(err);
          });
        }
      });
    }

    if (mode === "malformed") {
      return Promise.resolve(
        new Response("<html>Not JSON</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
    }

    if (mode === "server_error") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "internal server error" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    const body = typeof init?.body === "string" ? init.body : "";
    const params = new URLSearchParams(body);
    const token = params.get("response");

    const isTokenValid = mode === "ok" && token !== "invalid-token" && Boolean(token?.trim());

    return Promise.resolve(
      new Response(JSON.stringify({ success: isTokenValid }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

defineContractTests<CaptchaVerifier>(
  [
    {
      name: "NoopCaptchaVerifier",
      factory: () => new NoopCaptchaVerifier(),
    },
    {
      name: "HttpCaptchaVerifier",
      factory: () =>
        new HttpCaptchaVerifier({
          secretKey: "test-secret",
          fetchFn: createMockFetch("ok"),
        }),
    },
  ],
  (getAdapter) => {
    it("returns Result.ok when verification succeeds with a valid token", async () => {
      const verifier = getAdapter();
      const result = await verifier.verify("valid-production-challenge-token-12345");

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value).toBeUndefined();
      }
    });

    it("returns an InvalidCaptchaTokenError when token is empty or invalid", async () => {
      const verifier = getAdapter();

      const emptyResult = await verifier.verify("");
      expect(Result.isErr(emptyResult)).toBe(true);
      if (Result.isErr(emptyResult)) {
        expect(emptyResult.error).toBeInstanceOf(InvalidCaptchaTokenError);
        expect(emptyResult.error.code).toBe("INVALID_CAPTCHA_TOKEN");
      }

      const invalidResult = await verifier.verify("invalid-token");
      expect(Result.isErr(invalidResult)).toBe(true);
      if (Result.isErr(invalidResult)) {
        expect(invalidResult.error).toBeInstanceOf(InvalidCaptchaTokenError);
      }
    });
  },
);

describe("CaptchaVerifier failure-mode contracts", () => {
  it("enforces timeout failure contract across adapters", async () => {
    const noopTimeout = new NoopCaptchaVerifier({ simulatedFailure: "timeout" });
    const noopRes = await noopTimeout.verify("any-token");
    expect(Result.isErr(noopRes)).toBe(true);
    if (Result.isErr(noopRes)) {
      expect(noopRes.error).toBeInstanceOf(CaptchaTimeoutError);
      expect(noopRes.error.code).toBe("CAPTCHA_TIMEOUT");
      expect(noopRes.error.httpStatusHint).toBe(504);
    }

    const httpTimeout = new HttpCaptchaVerifier({
      secretKey: "test-secret",
      timeoutMs: 10,
      fetchFn: createMockFetch("timeout"),
    });
    const httpRes = await httpTimeout.verify("any-token");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(CaptchaTimeoutError);
      expect(httpRes.error.code).toBe("CAPTCHA_TIMEOUT");
    }
  });

  it("enforces malformed response failure contract across adapters", async () => {
    const noopMalformed = new NoopCaptchaVerifier({ simulatedFailure: "malformed" });
    const noopRes = await noopMalformed.verify("any-token");
    expect(Result.isErr(noopRes)).toBe(true);
    if (Result.isErr(noopRes)) {
      expect(noopRes.error).toBeInstanceOf(MalformedCaptchaResponseError);
      expect(noopRes.error.code).toBe("CAPTCHA_MALFORMED_RESPONSE");
      expect(noopRes.error.httpStatusHint).toBe(502);
    }

    const httpMalformed = new HttpCaptchaVerifier({
      secretKey: "test-secret",
      fetchFn: createMockFetch("malformed"),
    });
    const httpRes = await httpMalformed.verify("any-token");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(MalformedCaptchaResponseError);
    }
  });

  it("enforces service unavailable failure contract across adapters", async () => {
    const noopServiceErr = new NoopCaptchaVerifier({ simulatedFailure: "service_error" });
    const noopRes = await noopServiceErr.verify("any-token");
    expect(Result.isErr(noopRes)).toBe(true);
    if (Result.isErr(noopRes)) {
      expect(noopRes.error).toBeInstanceOf(CaptchaServiceError);
      expect(noopRes.error.code).toBe("CAPTCHA_SERVICE_UNAVAILABLE");
      expect(noopRes.error.httpStatusHint).toBe(503);
    }

    const httpServiceErr = new HttpCaptchaVerifier({
      secretKey: "test-secret",
      fetchFn: createMockFetch("server_error"),
    });
    const httpRes = await httpServiceErr.verify("any-token");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(CaptchaServiceError);
    }
  });
});
