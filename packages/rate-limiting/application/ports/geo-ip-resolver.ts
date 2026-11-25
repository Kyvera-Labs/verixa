import { DomainError, type Result } from "@verixa/shared-kernel";

export interface GeoLocation {
  /** The IPv4 or IPv6 address resolved. */
  readonly ip: string;
  /** ISO 3166-1 alpha-2 country code (e.g., 'US', 'DE', 'NG'). */
  readonly countryCode: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly city?: string | undefined;
  readonly timezone?: string | undefined;
}

/**
 * Base error type for IP geolocation resolution failures.
 */
export abstract class GeoIpError extends DomainError {}

/**
 * The provided IP address string is malformed or not a valid public IP.
 */
export class InvalidIpAddressError extends GeoIpError {
  readonly code = "INVALID_IP_ADDRESS";
  readonly httpStatusHint = 400;

  constructor(message = "Provided string is not a valid IP address") {
    super(message);
  }
}

/**
 * The external IP geolocation provider timed out before responding.
 */
export class GeoIpTimeoutError extends GeoIpError {
  readonly code = "GEO_IP_TIMEOUT";
  readonly httpStatusHint = 504;

  constructor(message = "GeoIP service lookup timed out") {
    super(message);
  }
}

/**
 * The GeoIP provider returned a malformed or incomplete payload missing required coordinates.
 */
export class MalformedGeoResponseError extends GeoIpError {
  readonly code = "GEO_IP_MALFORMED_RESPONSE";
  readonly httpStatusHint = 502;

  constructor(message = "GeoIP service returned a malformed response") {
    super(message);
  }
}

/**
 * The GeoIP service returned an upstream failure or was unreachable over the network.
 */
export class GeoIpServiceError extends GeoIpError {
  readonly code = "GEO_IP_SERVICE_UNAVAILABLE";
  readonly httpStatusHint = 503;

  constructor(message = "GeoIP resolution service is currently unavailable") {
    super(message);
  }
}

/**
 * Port for IP-to-geographic location resolution.
 *
 * Provides a location lookup seam for fraud and anomaly heuristics (e.g. impossible travel
 * detection in Issue 291). Real providers (MaxMind GeoIP2, ip-api, IP2Location) and in-memory
 * fixture stubs satisfy this same contract.
 *
 * Method contracts:
 * - `resolve` accepts a valid IPv4 or IPv6 address string.
 * - On success, returns `Result.ok(GeoLocation)` containing country code, latitude, and longitude.
 * - Malformed IP strings return `InvalidIpAddressError`.
 * - Network timeouts return `GeoIpTimeoutError`.
 * - Upstream provider errors return `GeoIpServiceError` or `MalformedGeoResponseError`.
 */
export interface GeoIpResolver {
  /**
   * Resolves an IP address to approximate geographic coordinates.
   *
   * @param ip IPv4 or IPv6 address string
   * @returns Result containing GeoLocation or a specific GeoIpError
   */
  resolve(ip: string): Promise<Result<GeoLocation, GeoIpError>>;
}
