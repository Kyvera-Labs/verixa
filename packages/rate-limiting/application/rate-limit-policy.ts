import { z } from "zod";

/**
 * Zod schema validating a route's rate-limiting policy.
 * Enforces fail-fast validation at startup.
 */
export const routePolicyConfigSchema = z.object({
  /** Maximum number of requests/tokens permitted in the time window. */
  limit: z.number().int().positive("Rate limit must be a positive integer"),

  /** Duration of the rate limit window in milliseconds. Must be at least 1,000ms. */
  windowMs: z.number().int().min(1000, "Window duration must be at least 1000ms"),

  /**
   * Maximum burst capacity for token bucket algorithms.
   * Defaults to `limit` if omitted.
   */
  capacity: z.number().positive("Capacity must be positive").optional(),

  /**
   * Refill rate in tokens per second for token bucket algorithms.
   * Defaults to `capacity / (windowMs / 1000)` if omitted.
   */
  refillRatePerSecond: z.number().positive("Refill rate must be positive").optional(),
});

export type RoutePolicyConfigInput = z.input<typeof routePolicyConfigSchema>;
export type RoutePolicyConfig = z.output<typeof routePolicyConfigSchema>;

export interface ResolvedRoutePolicy extends RoutePolicyConfig {
  /** The effective maximum burst capacity. */
  readonly capacity: number;

  /** The effective token refill rate per second. */
  readonly refillRatePerSecond: number;

  /** The matched route key or 'default'. */
  readonly matchedRoute: string;
}

/**
 * Baseline default policy for general API traffic.
 * 60 requests per 60 seconds (1 request per second steady state, burst of 60).
 */
export const GENERAL_API_DEFAULT_POLICY: ResolvedRoutePolicy = {
  limit: 60,
  windowMs: 60_000,
  capacity: 60,
  refillRatePerSecond: 1.0,
  matchedRoute: "default",
};

/**
 * Built-in default policies with distinct rate limits for sensitive routes.
 * Stricter auth endpoints have tighter limits to prevent brute-force attacks.
 */
export const DEFAULT_ROUTE_POLICIES: Readonly<Record<string, RoutePolicyConfigInput>> = {
  // Strictest: 5 attempts per minute to mitigate credential stuffing
  login: {
    limit: 5,
    windowMs: 60_000,
    capacity: 5,
    refillRatePerSecond: 5 / 60,
  },
  // High friction: 3 registrations per minute to stop automated account creation
  register: {
    limit: 3,
    windowMs: 60_000,
    capacity: 3,
    refillRatePerSecond: 3 / 60,
  },
  // Sensitive: 3 password reset requests per minute to prevent token flooding
  "password-reset": {
    limit: 3,
    windowMs: 60_000,
    capacity: 3,
    refillRatePerSecond: 3 / 60,
  },
  // Default general API traffic
  default: GENERAL_API_DEFAULT_POLICY,
};

/**
 * Normalizes an arbitrary route string, path, or operation name to a canonical policy key.
 * Examples:
 * - "POST /api/v1/auth/login" -> "login"
 * - "/login" -> "login"
 * - "AUTH_LOGIN" -> "login"
 * - "password-reset" -> "password-reset"
 */
export function normalizeRouteName(route: string): string {
  const cleaned = route.trim().toLowerCase();
  if (cleaned.length === 0) {
    return "default";
  }

  // Strip HTTP method if present (e.g. "POST /login" -> "/login")
  const withoutMethod = cleaned.replace(/^(get|post|put|delete|patch|options|head)\s+/, "");

  // Match known endpoints
  if (withoutMethod.includes("login")) {
    return "login";
  }
  if (withoutMethod.includes("register") || withoutMethod.includes("signup")) {
    return "register";
  }
  if (withoutMethod.includes("password-reset") || withoutMethod.includes("reset-password")) {
    return "password-reset";
  }

  // Strip leading/trailing slashes and query parameters
  const pathOnly = withoutMethod.split("?")[0]!.replace(/^\/+|\/+$/g, "");
  return pathOnly.length > 0 ? pathOnly : "default";
}

/**
 * Resolves the appropriate rate-limit policy for a given route name.
 * Falls back to the documented general API default if no specific route policy is found.
 */
export function resolveRoutePolicy(
  routeName: string,
  customPolicies: Record<string, RoutePolicyConfigInput> = {},
): ResolvedRoutePolicy {
  const normalizedKey = normalizeRouteName(routeName);

  // Check custom policies first, then built-in policies
  const candidate = customPolicies[normalizedKey] ?? DEFAULT_ROUTE_POLICIES[normalizedKey];

  if (!candidate) {
    const fallback = customPolicies["default"] ?? DEFAULT_ROUTE_POLICIES["default"]!;
    const validatedFallback = routePolicyConfigSchema.parse(fallback);
    const capacity = validatedFallback.capacity ?? validatedFallback.limit;
    const refillRatePerSecond =
      validatedFallback.refillRatePerSecond ?? capacity / (validatedFallback.windowMs / 1000);

    return {
      ...validatedFallback,
      capacity,
      refillRatePerSecond,
      matchedRoute: "default",
    };
  }

  const validated = routePolicyConfigSchema.parse(candidate);
  const capacity = validated.capacity ?? validated.limit;
  const refillRatePerSecond =
    validated.refillRatePerSecond ?? capacity / (validated.windowMs / 1000);

  return {
    ...validated,
    capacity,
    refillRatePerSecond,
    matchedRoute: normalizedKey,
  };
}

/**
 * Validates and registries a map of route policies.
 * Fails fast at startup if any route configuration violates validation rules.
 */
export class RateLimitPolicyRegistry {
  private readonly policies = new Map<string, ResolvedRoutePolicy>();
  private readonly defaultPolicy: ResolvedRoutePolicy;

  constructor(customPolicies: Record<string, RoutePolicyConfigInput> = {}) {
    // Fail-fast validate all incoming custom policies
    for (const [route, config] of Object.entries(customPolicies)) {
      const validated = routePolicyConfigSchema.parse(config);
      const capacity = validated.capacity ?? validated.limit;
      const refillRatePerSecond =
        validated.refillRatePerSecond ?? capacity / (validated.windowMs / 1000);
      this.policies.set(normalizeRouteName(route), {
        ...validated,
        capacity,
        refillRatePerSecond,
        matchedRoute: normalizeRouteName(route),
      });
    }

    const defaultRaw = customPolicies["default"] ?? DEFAULT_ROUTE_POLICIES["default"]!;
    const validatedDefault = routePolicyConfigSchema.parse(defaultRaw);
    const defaultCapacity = validatedDefault.capacity ?? validatedDefault.limit;
    const defaultRefill =
      validatedDefault.refillRatePerSecond ?? defaultCapacity / (validatedDefault.windowMs / 1000);

    this.defaultPolicy = {
      ...validatedDefault,
      capacity: defaultCapacity,
      refillRatePerSecond: defaultRefill,
      matchedRoute: "default",
    };
  }

  /**
   * Resolves the configured policy for the specified route.
   */
  resolve(routeName: string): ResolvedRoutePolicy {
    const key = normalizeRouteName(routeName);

    const custom = this.policies.get(key);
    if (custom) {
      return custom;
    }

    const builtIn = DEFAULT_ROUTE_POLICIES[key];
    if (builtIn) {
      const validated = routePolicyConfigSchema.parse(builtIn);
      const capacity = validated.capacity ?? validated.limit;
      const refillRatePerSecond =
        validated.refillRatePerSecond ?? capacity / (validated.windowMs / 1000);
      return {
        ...validated,
        capacity,
        refillRatePerSecond,
        matchedRoute: key,
      };
    }

    return this.defaultPolicy;
  }
}
