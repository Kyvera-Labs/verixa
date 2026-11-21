import { describe, expect, it } from "vitest";

import { StaticGeoIpResolver } from "../../infrastructure/adapters/static-geo-ip-resolver.js";

import {
  calculateHaversineDistanceKm,
  ImpossibleTravelDetector,
} from "./impossible-travel-detector.js";

describe("calculateHaversineDistanceKm", () => {
  it("calculates accurate distance between known city coordinates", () => {
    // SF: 37.7749, -122.4194 to NYC: 40.7128, -74.0060 (~4,130 km)
    const distance = calculateHaversineDistanceKm(37.7749, -122.4194, 40.7128, -74.006);
    expect(distance).toBeGreaterThan(4100);
    expect(distance).toBeLessThan(4200);
  });

  it("returns zero distance for identical coordinates", () => {
    expect(calculateHaversineDistanceKm(52.52, 13.405, 52.52, 13.405)).toBe(0);
  });
});

describe("ImpossibleTravelDetector", () => {
  const ipSanFrancisco = "198.51.100.1";
  const ipBerlin = "203.0.113.50";
  const ipLondon = "198.51.100.99";

  const geoResolver = new StaticGeoIpResolver({
    staticEntries: {
      [ipSanFrancisco]: {
        countryCode: "US",
        latitude: 37.7749,
        longitude: -122.4194,
        city: "San Francisco",
      },
      [ipBerlin]: {
        countryCode: "DE",
        latitude: 52.52,
        longitude: 13.405,
        city: "Berlin",
      },
      [ipLondon]: {
        countryCode: "GB",
        latitude: 51.5074,
        longitude: -0.1278,
        city: "London",
      },
    },
  });

  it("does not flag the first observed login for an account", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver);
    const flag = await detector.checkAndRecord("user@example.com", ipSanFrancisco);

    expect(flag.flagged).toBe(false);
  });

  it("flags logins between distant geographic locations occurring in an implausibly short window", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver, {
      maxPlausibleSpeedKmH: 900,
    });
    const account = "alice@example.com";
    const t0 = 1_700_000_000_000;

    // Login 1 from San Francisco
    await detector.record(account, ipSanFrancisco, t0);

    // Login 2 from Berlin only 15 minutes later (~9,100 km away)
    const t1 = t0 + 15 * 60 * 1000;
    const flag = await detector.check(account, ipBerlin, t1);

    expect(flag.flagged).toBe(true);
    expect(flag.type).toBe("impossible_travel");
    expect(flag.details).toBeDefined();
    expect(flag.details?.previousCountry).toBe("US");
    expect(flag.details?.currentCountry).toBe("DE");
  });

  it("does not flag logins from the same region or nearby locations", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver);
    const account = "bob@example.com";
    const t0 = 1_700_000_000_000;

    await detector.record(account, ipSanFrancisco, t0);

    // Second login from same IP 5 minutes later
    const flag = await detector.check(account, ipSanFrancisco, t0 + 5 * 60 * 1000);
    expect(flag.flagged).toBe(false);
  });

  it("does not flag distant logins if elapsed time permits realistic commercial flight travel", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver, {
      maxPlausibleSpeedKmH: 900,
    });
    const account = "carol@example.com";
    const t0 = 1_700_000_000_000;

    await detector.record(account, ipSanFrancisco, t0);

    // Login from Berlin 14 hours later (flight time feasible)
    const t1 = t0 + 14 * 60 * 60 * 1000;
    const flag = await detector.check(account, ipBerlin, t1);
    expect(flag.flagged).toBe(false);
  });

  it("remains advisory only and does not throw or block unresolvable IPs", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver);
    const flag = await detector.check("dave@example.com", "999.999.999.999");

    expect(flag.flagged).toBe(false);
  });

  it("clears user history on reset", async () => {
    const detector = new ImpossibleTravelDetector(geoResolver);
    const account = "eve@example.com";
    const t0 = 1_700_000_000_000;

    await detector.record(account, ipSanFrancisco, t0);
    detector.reset(account);

    const flag = await detector.check(account, ipBerlin, t0 + 60 * 1000);
    expect(flag.flagged).toBe(false);
  });
});
