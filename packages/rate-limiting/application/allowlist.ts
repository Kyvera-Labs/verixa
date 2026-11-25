/**
 * Structure of a rate-limit bypass audit event.
 * Bypass events are recorded to ensure rate-limit exemptions are never silent.
 */
export interface AllowlistBypassEvent {
  readonly subject: string;
  readonly matchType: "ip" | "cidr" | "token";
  readonly matchedRule: string;
  readonly timestamp: Date;
  readonly path?: string | undefined;
}

export interface LoggerLike {
  info(obj: object, msg?: string): void;
  info(msg: string): void;
}

export interface RateLimitAllowlistOptions {
  /**
   * List of trusted individual IP addresses (IPv4 or IPv6) or CIDR notations.
   * e.g. ["127.0.0.1", "10.0.0.0/8", "::1", "192.168.0.0/16"]
   */
  readonly ipAddressesOrCidrs?: readonly string[] | undefined;

  /**
   * List of trusted service-account bearer tokens.
   * e.g. ["service-health-probe", "monitoring-agent-token"]
   */
  readonly serviceTokens?: readonly string[] | undefined;

  /**
   * Logger used to log bypass events. Must never be silent.
   */
  readonly logger?: LoggerLike | undefined;

  /**
   * Callback hook called whenever a bypass is granted.
   */
  readonly onBypass?: ((event: AllowlistBypassEvent) => void) | undefined;
}

export interface AllowlistCheckSubject {
  readonly ip?: string | undefined;
  readonly bearerToken?: string | undefined;
  readonly path?: string | undefined;
}

export interface AllowlistCheckResult {
  readonly isAllowlisted: boolean;
  readonly matchType?: ("ip" | "cidr" | "token") | undefined;
  readonly matchedRule?: string | undefined;
}

/**
 * Checks whether an IPv4 address falls within a given CIDR block.
 */
export function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [range, prefixStr] = cidr.split("/");
  if (!range || !prefixStr) {
    return false;
  }

  const prefix = Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }

  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) {
    return false;
  }

  if (prefix === 0) {
    return true;
  }

  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (let i = 0; i < 4; i++) {
    const octet = Number.parseInt(parts[i]!, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255 || parts[i] !== octet.toString()) {
      return null;
    }
    result = ((result << 8) | octet) >>> 0;
  }
  return result;
}

/**
 * Normalizes an IPv6 address string into a 128-bit BigInt for bitmask matching.
 */
function ipv6ToBigInt(ip: string): bigint | null {
  const trimmed = ip.trim().toLowerCase();
  if (!trimmed.includes(":")) {
    return null;
  }

  // Handle IPv4-mapped IPv6 (::ffff:192.168.1.1)
  if (trimmed.includes(".")) {
    const lastColon = trimmed.lastIndexOf(":");
    const ipv4Part = trimmed.substring(lastColon + 1);
    const ipv4Int = ipv4ToInt(ipv4Part);
    if (ipv4Int === null) {
      return null;
    }
    const prefixIpv6 =
      trimmed.substring(0, lastColon + 1) +
      (ipv4Int >>> 16).toString(16) +
      ":" +
      (ipv4Int & 0xffff).toString(16);
    return ipv6ToBigInt(prefixIpv6);
  }

  const halves = trimmed.split("::");
  if (halves.length > 2) {
    return null;
  }

  let leftParts: string[] = [];
  let rightParts: string[] = [];

  if (halves[0]) {
    leftParts = halves[0].split(":").filter(Boolean);
  }
  if (halves[1]) {
    rightParts = halves[1].split(":").filter(Boolean);
  }

  const totalSegments = 8;
  const missingSegments = totalSegments - (leftParts.length + rightParts.length);
  if (halves.length === 2 && missingSegments < 0) {
    return null;
  }

  const fillerCount = halves.length === 2 ? missingSegments : 0;
  const fillerSegments: string[] = Array.from({ length: fillerCount }, () => "0");

  const fullSegments: string[] = [...leftParts, ...fillerSegments, ...rightParts];

  if (fullSegments.length !== 8) {
    return null;
  }

  let result = 0n;
  for (const seg of fullSegments) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) {
      return null;
    }
    const num = BigInt(Number.parseInt(seg, 16));
    result = (result << 16n) | num;
  }

  return result;
}

/**
 * Checks whether an IPv6 address falls within a given CIDR block.
 */
export function matchIpv6Cidr(ip: string, cidr: string): boolean {
  const [range, prefixStr] = cidr.split("/");
  if (!range || !prefixStr) {
    return false;
  }

  const prefix = Number.parseInt(prefixStr, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 128) {
    return false;
  }

  const ipVal = ipv6ToBigInt(ip);
  const rangeVal = ipv6ToBigInt(range);
  if (ipVal === null || rangeVal === null) {
    return false;
  }

  if (prefix === 0) {
    return true;
  }

  const shift = BigInt(128 - prefix);
  const mask = ((1n << 128n) - 1n) ^ ((1n << shift) - 1n);
  return (ipVal & mask) === (rangeVal & mask);
}

/**
 * Rate-limiting allowlist exempting internal health checks, monitoring probes,
 * and trusted service-to-service calls from rate limiting.
 *
 * All bypasses are explicitly logged to prevent silent security circumvention.
 */
export class RateLimitAllowlist {
  private readonly exactIps = new Set<string>();
  private readonly ipv4Cidrs: string[] = [];
  private readonly ipv6Cidrs: string[] = [];
  private readonly serviceTokens = new Set<string>();
  private readonly logger?: LoggerLike | undefined;
  private readonly onBypass?: ((event: AllowlistBypassEvent) => void) | undefined;

  constructor(options: RateLimitAllowlistOptions = {}) {
    this.logger = options.logger;
    this.onBypass = options.onBypass;

    if (options.ipAddressesOrCidrs) {
      for (const entry of options.ipAddressesOrCidrs) {
        const trimmed = entry.trim();
        if (!trimmed) continue;

        if (trimmed.includes("/")) {
          if (trimmed.includes(":")) {
            this.ipv6Cidrs.push(trimmed);
          } else {
            this.ipv4Cidrs.push(trimmed);
          }
        } else {
          this.exactIps.add(trimmed.toLowerCase());
        }
      }
    }

    if (options.serviceTokens) {
      for (const token of options.serviceTokens) {
        const cleaned = token.replace(/^bearer\s+/i, "").trim();
        if (cleaned) {
          this.serviceTokens.add(cleaned);
        }
      }
    }
  }

  /**
   * Tests if the incoming request matches any allowlist rule.
   */
  check(subject: AllowlistCheckSubject): AllowlistCheckResult {
    // 1. Check Service Tokens
    if (subject.bearerToken) {
      const cleaned = subject.bearerToken.replace(/^bearer\s+/i, "").trim();
      if (this.serviceTokens.has(cleaned)) {
        return {
          isAllowlisted: true,
          matchType: "token",
          matchedRule: cleaned,
        };
      }
    }

    // 2. Check Client IP
    if (subject.ip) {
      const normalizedIp = subject.ip.trim().toLowerCase();

      // Exact IP match
      if (this.exactIps.has(normalizedIp)) {
        return {
          isAllowlisted: true,
          matchType: "ip",
          matchedRule: normalizedIp,
        };
      }

      // IPv4 CIDR match
      if (!normalizedIp.includes(":")) {
        for (const cidr of this.ipv4Cidrs) {
          if (matchIpv4Cidr(normalizedIp, cidr)) {
            return {
              isAllowlisted: true,
              matchType: "cidr",
              matchedRule: cidr,
            };
          }
        }
      }

      // IPv6 CIDR match
      if (normalizedIp.includes(":")) {
        for (const cidr of this.ipv6Cidrs) {
          if (matchIpv6Cidr(normalizedIp, cidr)) {
            return {
              isAllowlisted: true,
              matchType: "cidr",
              matchedRule: cidr,
            };
          }
        }
      }
    }

    return { isAllowlisted: false };
  }

  /**
   * Evaluates if a request is allowlisted, and if so, emits an audit bypass log.
   */
  isAllowlisted(subject: AllowlistCheckSubject): boolean {
    const result = this.check(subject);
    if (!result.isAllowlisted) {
      return false;
    }

    const event: AllowlistBypassEvent = {
      subject: subject.ip ?? (subject.bearerToken ? "service-token" : "unknown"),
      matchType: result.matchType!,
      matchedRule: result.matchedRule!,
      timestamp: new Date(),
      path: subject.path,
    };

    // Log the bypass event (never silent)
    if (this.logger) {
      this.logger.info(
        { bypassEvent: event },
        `Rate limit bypassed for allowlisted ${event.matchType}: ${event.subject} (matched ${event.matchedRule})`,
      );
    }

    this.onBypass?.(event);

    return true;
  }
}
