import { isIP } from "node:net";

import { Result } from "@verixa/shared-kernel";

import {
  type GeoIpError,
  type GeoIpResolver,
  type GeoLocation,
  GeoIpServiceError,
  GeoIpTimeoutError,
  InvalidIpAddressError,
  MalformedGeoResponseError,
} from "../../application/ports/geo-ip-resolver.js";

export interface HttpGeoIpResolverConfig {
  readonly baseUrl?: string | undefined;
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchFn?: typeof fetch | undefined;
}

/**
 * HTTP adapter for IP geolocation resolution.
 *
 * Calls an external GeoIP API endpoint, validates the coordinates in the payload,
 * and translates network timeouts and parsing failures into domain Result errors.
 */
export class HttpGeoIpResolver implements GeoIpResolver {
  private readonly baseUrl: string;
  private readonly apiKey?: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: HttpGeoIpResolverConfig = {}) {
    this.baseUrl = config.baseUrl ?? "https://geoip.example.internal/v1";
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 3000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
  }

  async resolve(ip: string): Promise<Result<GeoLocation, GeoIpError>> {
    const trimmed = ip.trim();
    if (!trimmed || isIP(trimmed) === 0) {
      return Result.err(new InvalidIpAddressError(`'${ip}' is not a valid IP address`));
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(trimmed)}`);
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await this.fetchFn(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (response.status >= 500) {
        return Result.err(
          new GeoIpServiceError(`Upstream GeoIP provider failed with status ${response.status}`),
        );
      }

      if (response.status === 404) {
        return Result.err(
          new InvalidIpAddressError(`IP address '${trimmed}' not found in registry`),
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        return Result.err(new MalformedGeoResponseError("Failed to parse GeoIP response as JSON"));
      }

      if (typeof data !== "object" || data === null) {
        return Result.err(new MalformedGeoResponseError("GeoIP response was not an object"));
      }

      const obj = data as Record<string, unknown>;
      const countryCode = typeof obj.countryCode === "string" ? obj.countryCode : undefined;
      const latitude = typeof obj.latitude === "number" ? obj.latitude : undefined;
      const longitude = typeof obj.longitude === "number" ? obj.longitude : undefined;

      if (!countryCode || latitude === undefined || longitude === undefined) {
        return Result.err(
          new MalformedGeoResponseError("GeoIP response missing countryCode or coordinates"),
        );
      }

      return Result.ok({
        ip: trimmed,
        countryCode,
        latitude,
        longitude,
        city: typeof obj.city === "string" ? obj.city : undefined,
        timezone: typeof obj.timezone === "string" ? obj.timezone : undefined,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return Result.err(
          new GeoIpTimeoutError(`GeoIP request exceeded ${this.timeoutMs}ms timeout`),
        );
      }

      return Result.err(
        new GeoIpServiceError(
          err instanceof Error ? err.message : "Network error contacting GeoIP service",
        ),
      );
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
