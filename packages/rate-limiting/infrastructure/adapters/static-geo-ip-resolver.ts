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

export interface StaticGeoIpResolverOptions {
  /** In-memory lookup map of IP address -> GeoLocation. */
  readonly staticEntries?: Record<string, Partial<GeoLocation>> | undefined;
  /** Default location returned for unmapped valid public IPs. */
  readonly defaultLocation?: Omit<GeoLocation, "ip"> | undefined;
  /** Simulated failure mode for testing error handling. */
  readonly simulatedFailure?: "timeout" | "malformed" | "service_error" | undefined;
}

/**
 * In-memory static adapter for GeoIP resolution.
 *
 * Resolves IP addresses using an in-memory dictionary or deterministic fallback,
 * enabling deterministic tests for impossible-travel heuristics without external network calls.
 */
export class StaticGeoIpResolver implements GeoIpResolver {
  private readonly staticEntries: Record<string, Partial<GeoLocation>>;
  private readonly defaultLocation: Omit<GeoLocation, "ip">;
  private readonly simulatedFailure?: "timeout" | "malformed" | "service_error" | undefined;

  constructor(options: StaticGeoIpResolverOptions = {}) {
    this.staticEntries = options.staticEntries ?? {
      "198.51.100.1": {
        countryCode: "US",
        latitude: 37.7749,
        longitude: -122.4194,
        city: "San Francisco",
        timezone: "America/Los_Angeles",
      },
      "203.0.113.50": {
        countryCode: "DE",
        latitude: 52.52,
        longitude: 13.405,
        city: "Berlin",
        timezone: "Europe/Berlin",
      },
      "127.0.0.1": {
        countryCode: "US",
        latitude: 37.7749,
        longitude: -122.4194,
        city: "Localhost",
        timezone: "UTC",
      },
    };
    this.defaultLocation = options.defaultLocation ?? {
      countryCode: "US",
      latitude: 40.7128,
      longitude: -74.006,
      city: "New York",
      timezone: "America/New_York",
    };
    this.simulatedFailure = options.simulatedFailure;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolve(ip: string): Promise<Result<GeoLocation, GeoIpError>> {
    if (this.simulatedFailure === "timeout") {
      return Result.err(new GeoIpTimeoutError());
    }

    if (this.simulatedFailure === "malformed") {
      return Result.err(new MalformedGeoResponseError());
    }

    if (this.simulatedFailure === "service_error") {
      return Result.err(new GeoIpServiceError());
    }

    const trimmed = ip.trim();
    if (!trimmed || isIP(trimmed) === 0) {
      return Result.err(new InvalidIpAddressError(`'${ip}' is not a valid IP address`));
    }

    const match = this.staticEntries[trimmed];
    if (match) {
      return Result.ok({
        ip: trimmed,
        countryCode: match.countryCode ?? this.defaultLocation.countryCode,
        latitude: match.latitude ?? this.defaultLocation.latitude,
        longitude: match.longitude ?? this.defaultLocation.longitude,
        city: match.city ?? this.defaultLocation.city,
        timezone: match.timezone ?? this.defaultLocation.timezone,
      });
    }

    return Result.ok({
      ip: trimmed,
      ...this.defaultLocation,
    });
  }
}
