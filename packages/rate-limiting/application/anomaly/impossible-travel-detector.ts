import { Result } from "@verixa/shared-kernel";

import type { GeoIpResolver, GeoLocation } from "../ports/geo-ip-resolver.js";

/**
 * Standard anomaly flag emitted by anomaly detectors.
 * Advisory signal indicating suspected abuse or credential compromise without blocking the user.
 */
export interface AnomalyFlag {
  readonly flagged: boolean;
  readonly type?: "impossible_travel" | "volume_spike" | undefined;
  readonly reason?: string | undefined;
  /** Normalized severity score between 0.0 (benign) and 1.0 (critical anomaly) */
  readonly score?: number | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

export interface ImpossibleTravelDetectorOptions {
  /**
   * Maximum plausible travel speed in kilometers per hour.
   * Default is 900 km/h (maximum cruising speed of commercial passenger airliners).
   */
  readonly maxPlausibleSpeedKmH?: number | undefined;
  /**
   * Minimum distance in kilometers required before evaluating travel feasibility.
   * Prevents false positives caused by ISP gateway hops, cellular tower changes, or geo-IP jitter.
   * Default is 50 km.
   */
  readonly minDistanceKm?: number | undefined;
}

interface UserLocationRecord {
  readonly location: GeoLocation;
  readonly timestamp: number;
}

/**
 * Earth radius in kilometers for Haversine distance calculations.
 */
const EARTH_RADIUS_KM = 6371;

/**
 * Computes great-circle distance between two geographic coordinates using the Haversine formula.
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(EARTH_RADIUS_KM * c * 10) / 10;
}

/**
 * ImpossibleTravelDetector
 *
 * Implements an advisory impossible-travel heuristic for authentication attempts:
 * 1. Resolves client IP to approximate geographic coordinates using GeoIpResolver.
 * 2. Compares the current login against the account's previous observed login location and timestamp.
 * 3. Flags an anomaly if implied travel speed exceeds commercial flight thresholds.
 *
 * Note: Per architectural design, this detector is advisory only: it raises an AnomalyFlag for
 * risk scoring, stepped-up authentication (MFA/CAPTCHA), or audit logging, but does NOT block logins.
 */
export class ImpossibleTravelDetector {
  private readonly maxPlausibleSpeedKmH: number;
  private readonly minDistanceKm: number;
  private readonly userHistory = new Map<string, UserLocationRecord>();

  constructor(
    private readonly geoIpResolver: GeoIpResolver,
    options: ImpossibleTravelDetectorOptions = {},
  ) {
    this.maxPlausibleSpeedKmH = Math.max(100, options.maxPlausibleSpeedKmH ?? 900);
    this.minDistanceKm = Math.max(0, options.minDistanceKm ?? 50);
  }

  /**
   * Checks whether the current login implies physically impossible travel from the previous login,
   * and updates the user's recorded location.
   */
  async checkAndRecord(
    accountIdentifier: string,
    clientIp: string,
    now: number = Date.now(),
  ): Promise<AnomalyFlag> {
    const flag = await this.check(accountIdentifier, clientIp, now);
    await this.record(accountIdentifier, clientIp, now);
    return flag;
  }

  /**
   * Evaluates the current attempt against the user's recorded location history without updating state.
   */
  async check(
    accountIdentifier: string,
    clientIp: string,
    now: number = Date.now(),
  ): Promise<AnomalyFlag> {
    const geoResult = await this.geoIpResolver.resolve(clientIp);
    if (Result.isErr(geoResult)) {
      // Unresolvable IP: cannot evaluate distance, return unflagged
      return { flagged: false };
    }

    const currentLocation = geoResult.value;
    const key = accountIdentifier.trim().toLowerCase();
    const previous = this.userHistory.get(key);

    if (!previous) {
      // First observed login for this user
      return { flagged: false };
    }

    const elapsedMs = Math.max(0, now - previous.timestamp);
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    const distanceKm = calculateHaversineDistanceKm(
      previous.location.latitude,
      previous.location.longitude,
      currentLocation.latitude,
      currentLocation.longitude,
    );

    // If within same locality or minimum distance, do not flag
    if (distanceKm < this.minDistanceKm) {
      return { flagged: false };
    }

    // If elapsed time is negligible (e.g. under 1 second) across distance, speed is effectively infinite
    const speedKmH = elapsedHours > 0 ? distanceKm / elapsedHours : Infinity;

    if (speedKmH > this.maxPlausibleSpeedKmH) {
      const score = Math.min(
        1.0,
        Math.round((speedKmH / (this.maxPlausibleSpeedKmH * 2)) * 100) / 100,
      );
      return {
        flagged: true,
        type: "impossible_travel",
        reason: `Implausible travel speed detected (${Math.round(speedKmH)} km/h across ${Math.round(distanceKm)} km)`,
        score,
        details: {
          previousIp: previous.location.ip,
          currentIp: currentLocation.ip,
          previousCountry: previous.location.countryCode,
          currentCountry: currentLocation.countryCode,
          distanceKm,
          elapsedMinutes: Math.round(elapsedMs / (1000 * 60)),
          calculatedSpeedKmH: Math.round(speedKmH),
          thresholdSpeedKmH: this.maxPlausibleSpeedKmH,
        },
      };
    }

    return { flagged: false };
  }

  /**
   * Records or updates the user's last known geographic location and timestamp.
   */
  async record(
    accountIdentifier: string,
    clientIp: string,
    now: number = Date.now(),
  ): Promise<void> {
    const geoResult = await this.geoIpResolver.resolve(clientIp);
    if (Result.isOk(geoResult)) {
      const key = accountIdentifier.trim().toLowerCase();
      this.userHistory.set(key, {
        location: geoResult.value,
        timestamp: now,
      });
    }
  }

  /**
   * Clears recorded location history for an account.
   */
  reset(accountIdentifier: string): void {
    const key = accountIdentifier.trim().toLowerCase();
    this.userHistory.delete(key);
  }
}
