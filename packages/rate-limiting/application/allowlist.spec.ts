import { describe, expect, it, vi } from "vitest";

import {
  RateLimitAllowlist,
  matchIpv4Cidr,
  matchIpv6Cidr,
  type AllowlistBypassEvent,
} from "./allowlist.js";

describe("RateLimitAllowlist (Issue 304 / 289)", () => {
  describe("IPv4 CIDR matching", () => {
    it("matches IP within CIDR subnet", () => {
      expect(matchIpv4Cidr("192.168.1.100", "192.168.1.0/24")).toBe(true);
      expect(matchIpv4Cidr("192.168.1.1", "192.168.1.0/24")).toBe(true);
      expect(matchIpv4Cidr("192.168.2.1", "192.168.1.0/24")).toBe(false);

      expect(matchIpv4Cidr("10.50.25.1", "10.0.0.0/8")).toBe(true);
      expect(matchIpv4Cidr("11.0.0.1", "10.0.0.0/8")).toBe(false);

      expect(matchIpv4Cidr("127.0.0.1", "127.0.0.1/32")).toBe(true);
      expect(matchIpv4Cidr("127.0.0.2", "127.0.0.1/32")).toBe(false);

      expect(matchIpv4Cidr("8.8.8.8", "0.0.0.0/0")).toBe(true);
    });

    it("handles invalid IPv4 and CIDR strings gracefully", () => {
      expect(matchIpv4Cidr("invalid-ip", "10.0.0.0/8")).toBe(false);
      expect(matchIpv4Cidr("10.0.0.1", "invalid-cidr")).toBe(false);
      expect(matchIpv4Cidr("10.0.0.1", "10.0.0.0/33")).toBe(false);
      expect(matchIpv4Cidr("10.0.0.1", "10.0.0.0/-1")).toBe(false);
      expect(matchIpv4Cidr("999.999.999.999", "10.0.0.0/8")).toBe(false);
      expect(matchIpv4Cidr("1.2.3", "10.0.0.0/8")).toBe(false);
      expect(matchIpv4Cidr("1.2.3.4.5", "10.0.0.0/8")).toBe(false);
      expect(matchIpv4Cidr("1.2.3.-4", "10.0.0.0/8")).toBe(false);
      expect(matchIpv4Cidr("1.2.3.abc", "10.0.0.0/8")).toBe(false);
    });
  });

  describe("IPv6 CIDR matching", () => {
    it("matches IPv6 within CIDR subnet", () => {
      expect(matchIpv6Cidr("::1", "::1/128")).toBe(true);
      expect(matchIpv6Cidr("::2", "::1/128")).toBe(false);

      expect(matchIpv6Cidr("2001:db8::1", "2001:db8::/32")).toBe(true);
      expect(matchIpv6Cidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    });

    it("handles invalid IPv6 strings gracefully", () => {
      expect(matchIpv6Cidr("not-ipv6", "::1/128")).toBe(false);
      expect(matchIpv6Cidr("::1", "invalid")).toBe(false);
      expect(matchIpv6Cidr("::1", "::1/129")).toBe(false);
    });
  });

  describe("RateLimitAllowlist class", () => {
    it("bypasses exact match IPs", () => {
      const allowlist = new RateLimitAllowlist({
        ipAddressesOrCidrs: ["127.0.0.1", "::1"],
      });

      expect(allowlist.isAllowlisted({ ip: "127.0.0.1" })).toBe(true);
      expect(allowlist.isAllowlisted({ ip: "::1" })).toBe(true);
      expect(allowlist.isAllowlisted({ ip: "192.168.1.1" })).toBe(false);
    });

    it("bypasses IPv4 CIDR blocks", () => {
      const allowlist = new RateLimitAllowlist({
        ipAddressesOrCidrs: ["10.0.0.0/8", "172.16.0.0/12"],
      });

      expect(allowlist.isAllowlisted({ ip: "10.1.2.3" })).toBe(true);
      expect(allowlist.isAllowlisted({ ip: "172.20.10.5" })).toBe(true);
      expect(allowlist.isAllowlisted({ ip: "192.168.1.1" })).toBe(false);
    });

    it("bypasses IPv6 CIDR blocks", () => {
      const allowlist = new RateLimitAllowlist({
        ipAddressesOrCidrs: ["2001:db8::/32", "", "   "],
        serviceTokens: ["", "  ", "tok"],
      });

      expect(allowlist.isAllowlisted({ ip: "2001:db8::1" })).toBe(true);
      expect(allowlist.isAllowlisted({ ip: "2001:db9::1" })).toBe(false);
      expect(allowlist.isAllowlisted({})).toBe(false);
      expect(allowlist.isAllowlisted({ ip: "" })).toBe(false);
    });

    it("bypasses trusted service-account bearer tokens", () => {
      const allowlist = new RateLimitAllowlist({
        serviceTokens: ["health-checker-token", "monitoring-secret"],
      });

      expect(allowlist.isAllowlisted({ bearerToken: "health-checker-token" })).toBe(true);
      expect(allowlist.isAllowlisted({ bearerToken: "Bearer health-checker-token" })).toBe(true);
      expect(allowlist.isAllowlisted({ bearerToken: "BEARER monitoring-secret" })).toBe(true);
      expect(allowlist.isAllowlisted({ bearerToken: "untrusted-token" })).toBe(false);
    });

    it("records bypass events through logger and onBypass callback (never silent)", () => {
      const recordedEvents: AllowlistBypassEvent[] = [];
      const mockLogger = {
        info: vi.fn(),
      };

      const allowlist = new RateLimitAllowlist({
        ipAddressesOrCidrs: ["10.0.0.0/8"],
        serviceTokens: ["metrics-agent"],
        logger: mockLogger,
        onBypass: (evt) => recordedEvents.push(evt),
      });

      // Test IP CIDR bypass
      const ipResult = allowlist.isAllowlisted({ ip: "10.2.3.4", path: "/health" });
      expect(ipResult).toBe(true);
      expect(recordedEvents.length).toBe(1);
      expect(recordedEvents[0]!.matchType).toBe("cidr");
      expect(recordedEvents[0]!.matchedRule).toBe("10.0.0.0/8");
      expect(recordedEvents[0]!.path).toBe("/health");
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      // Test Token bypass
      const tokenResult = allowlist.isAllowlisted({ bearerToken: "Bearer metrics-agent" });
      expect(tokenResult).toBe(true);
      expect(recordedEvents.length).toBe(2);
      expect(recordedEvents[1]!.matchType).toBe("token");
      expect(recordedEvents[1]!.matchedRule).toBe("metrics-agent");
      expect(mockLogger.info).toHaveBeenCalledTimes(2);

      // Non-matching request should NOT emit any event or log
      const denied = allowlist.isAllowlisted({ ip: "8.8.8.8" });
      expect(denied).toBe(false);
      expect(recordedEvents.length).toBe(2);
      expect(mockLogger.info).toHaveBeenCalledTimes(2);
    });
  });
});
