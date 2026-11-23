import { Result } from "@verixa/shared-kernel";
import { defineContractTests } from "@verixa/testing-kit";
import { describe, expect, it } from "vitest";

import {
  type GeoIpResolver,
  GeoIpServiceError,
  GeoIpTimeoutError,
  InvalidIpAddressError,
  MalformedGeoResponseError,
} from "../../application/ports/geo-ip-resolver.js";
import { HttpGeoIpResolver } from "../adapters/http-geo-ip-resolver.js";
import { StaticGeoIpResolver } from "../adapters/static-geo-ip-resolver.js";

function createMockGeoFetch(mode: "ok" | "timeout" | "malformed" | "server_error"): typeof fetch {
  return (input, init) => {
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
        new Response(JSON.stringify({ notCoordinates: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (mode === "server_error") {
      return Promise.resolve(
        new Response("Service Unavailable", {
          status: 503,
        }),
      );
    }

    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const ip = url.pathname.split("/").pop();

    if (ip === "198.51.100.1") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            countryCode: "US",
            latitude: 37.7749,
            longitude: -122.4194,
            city: "San Francisco",
            timezone: "America/Los_Angeles",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          countryCode: "US",
          latitude: 40.7128,
          longitude: -74.006,
          city: "New York",
          timezone: "America/New_York",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

// #region contract
defineContractTests<GeoIpResolver>(
  [
    {
      name: "StaticGeoIpResolver",
      factory: () => new StaticGeoIpResolver(),
    },
    {
      name: "HttpGeoIpResolver",
      factory: () =>
        new HttpGeoIpResolver({
          fetchFn: createMockGeoFetch("ok"),
        }),
    },
  ],
  (getAdapter) => {
    it("resolves valid IP addresses to approximate coordinates and country code", async () => {
      const resolver = getAdapter();
      const result = await resolver.resolve("198.51.100.1");

      expect(Result.isOk(result)).toBe(true);
      if (Result.isOk(result)) {
        expect(result.value.ip).toBe("198.51.100.1");
        expect(result.value.countryCode).toBe("US");
        expect(typeof result.value.latitude).toBe("number");
        expect(typeof result.value.longitude).toBe("number");
      }
    });

    it("rejects invalid IP string formats with an InvalidIpAddressError", async () => {
      const resolver = getAdapter();

      const invalidStrings = ["", "not-an-ip", "999.999.999.999", "123.456.78.90"];
      for (const str of invalidStrings) {
        const result = await resolver.resolve(str);
        expect(Result.isErr(result)).toBe(true);
        if (Result.isErr(result)) {
          expect(result.error).toBeInstanceOf(InvalidIpAddressError);
          expect(result.error.code).toBe("INVALID_IP_ADDRESS");
        }
      }
    });
  },
);
// #endregion contract

describe("GeoIpResolver failure-mode contracts", () => {
  it("enforces timeout failure contract across adapters", async () => {
    const staticTimeout = new StaticGeoIpResolver({ simulatedFailure: "timeout" });
    const staticRes = await staticTimeout.resolve("198.51.100.1");
    expect(Result.isErr(staticRes)).toBe(true);
    if (Result.isErr(staticRes)) {
      expect(staticRes.error).toBeInstanceOf(GeoIpTimeoutError);
      expect(staticRes.error.code).toBe("GEO_IP_TIMEOUT");
      expect(staticRes.error.httpStatusHint).toBe(504);
    }

    const httpTimeout = new HttpGeoIpResolver({
      timeoutMs: 10,
      fetchFn: createMockGeoFetch("timeout"),
    });
    const httpRes = await httpTimeout.resolve("198.51.100.1");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(GeoIpTimeoutError);
      expect(httpRes.error.code).toBe("GEO_IP_TIMEOUT");
    }
  });

  it("enforces malformed response failure contract across adapters", async () => {
    const staticMalformed = new StaticGeoIpResolver({ simulatedFailure: "malformed" });
    const staticRes = await staticMalformed.resolve("198.51.100.1");
    expect(Result.isErr(staticRes)).toBe(true);
    if (Result.isErr(staticRes)) {
      expect(staticRes.error).toBeInstanceOf(MalformedGeoResponseError);
      expect(staticRes.error.code).toBe("GEO_IP_MALFORMED_RESPONSE");
      expect(staticRes.error.httpStatusHint).toBe(502);
    }

    const httpMalformed = new HttpGeoIpResolver({
      fetchFn: createMockGeoFetch("malformed"),
    });
    const httpRes = await httpMalformed.resolve("198.51.100.1");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(MalformedGeoResponseError);
    }
  });

  it("enforces service unavailable failure contract across adapters", async () => {
    const staticService = new StaticGeoIpResolver({ simulatedFailure: "service_error" });
    const staticRes = await staticService.resolve("198.51.100.1");
    expect(Result.isErr(staticRes)).toBe(true);
    if (Result.isErr(staticRes)) {
      expect(staticRes.error).toBeInstanceOf(GeoIpServiceError);
      expect(staticRes.error.code).toBe("GEO_IP_SERVICE_UNAVAILABLE");
      expect(staticRes.error.httpStatusHint).toBe(503);
    }

    const httpService = new HttpGeoIpResolver({
      fetchFn: createMockGeoFetch("server_error"),
    });
    const httpRes = await httpService.resolve("198.51.100.1");
    expect(Result.isErr(httpRes)).toBe(true);
    if (Result.isErr(httpRes)) {
      expect(httpRes.error).toBeInstanceOf(GeoIpServiceError);
    }
  });
});
