import type { RateLimitKey, RateLimitResult } from "@verixa/shared-kernel";

import type { AccountRateLimitResult } from "./account-strategy.js";
import { AccountRateLimitStrategy } from "./account-strategy.js";
import type { HttpRequestContext, IpRateLimitResult } from "./ip-strategy.js";
import { IpRateLimitStrategy } from "./ip-strategy.js";

/**
 * Context passed to CompositeRateLimitStrategy check operations.
 */
export interface CompositeRateLimitContext {
  request: HttpRequestContext;
  accountIdentifier: string;
  action?: RateLimitKey["action"];
  namespace?: string;
}

/**
 * Indicates which dimension caused the rate limit denial, if any.
 */
export type RateLimitDenialReason = "ip" | "account" | "both";

/**
 * Result returned by CompositeRateLimitStrategy.
 */
export interface CompositeRateLimitResult extends RateLimitResult {
  deniedBy?: RateLimitDenialReason;
  ipResult: IpRateLimitResult;
  accountResult: AccountRateLimitResult;
  strategy: "composite";
}

/**
 * Configuration options for CompositeRateLimitStrategy.
 */
export interface CompositeRateLimitStrategyOptions {
  ipStrategy?: IpRateLimitStrategy;
  accountStrategy?: AccountRateLimitStrategy;
  trustedProxyCount?: number;
  namespace?: string;
  defaultAction?: RateLimitKey["action"];
}

/**
 * CompositeRateLimitStrategy
 *
 * Combines IP-based and account-based rate limiting in a multi-dimensional defense:
 * 1. Evaluates both IP-based and account-based strategies.
 * 2. Denies the request if EITHER sub-strategy denies (strictest wins).
 * 3. Annotates the result with `deniedBy` ("ip" | "account" | "both") for security auditing and logging.
 */
export class CompositeRateLimitStrategy {
  private readonly ipStrategy: IpRateLimitStrategy;
  private readonly accountStrategy: AccountRateLimitStrategy;

  constructor(options: CompositeRateLimitStrategyOptions = {}) {
    this.ipStrategy =
      options.ipStrategy ??
      new IpRateLimitStrategy(undefined, {
        ...(options.trustedProxyCount !== undefined
          ? { trustedProxyCount: options.trustedProxyCount }
          : {}),
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        ...(options.defaultAction !== undefined ? { defaultAction: options.defaultAction } : {}),
      });

    this.accountStrategy =
      options.accountStrategy ??
      new AccountRateLimitStrategy(undefined, {
        ...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
        ...(options.defaultAction !== undefined ? { defaultAction: options.defaultAction } : {}),
      });
  }

  /**
   * Evaluates both IP and account sub-strategies and combines the decisions.
   */
  async check(context: CompositeRateLimitContext): Promise<CompositeRateLimitResult> {
    const clientIp = this.ipStrategy.resolveClientIp(context.request);

    const [ipResult, accountResult] = await Promise.all([
      this.ipStrategy.check({
        request: context.request,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
      this.accountStrategy.check({
        accountIdentifier: context.accountIdentifier,
        clientIp,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
    ]);

    let deniedBy: RateLimitDenialReason | undefined;
    if (!ipResult.allowed && !accountResult.allowed) {
      deniedBy = "both";
    } else if (!ipResult.allowed) {
      deniedBy = "ip";
    } else if (!accountResult.allowed) {
      deniedBy = "account";
    }

    const allowed = ipResult.allowed && accountResult.allowed;
    const remaining = Math.min(ipResult.remaining, accountResult.remaining);
    const resetAt = Math.max(ipResult.resetAt, accountResult.resetAt);
    const limit = Math.min(ipResult.limit, accountResult.limit);

    return {
      allowed,
      remaining,
      resetAt,
      limit,
      ...(deniedBy !== undefined ? { deniedBy } : {}),
      ipResult,
      accountResult,
      strategy: "composite",
    };
  }

  /**
   * Records a failed attempt across both IP and account dimensions.
   */
  async recordFailure(context: CompositeRateLimitContext): Promise<void> {
    const clientIp = this.ipStrategy.resolveClientIp(context.request);

    await Promise.all([
      this.ipStrategy.recordFailure({
        request: context.request,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
      this.accountStrategy.recordFailure({
        accountIdentifier: context.accountIdentifier,
        clientIp,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
    ]);
  }

  /**
   * Resets rate limits for both IP and account dimensions.
   */
  async reset(context: CompositeRateLimitContext): Promise<void> {
    const clientIp = this.ipStrategy.resolveClientIp(context.request);

    await Promise.all([
      this.ipStrategy.reset({
        request: context.request,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
      this.accountStrategy.reset({
        accountIdentifier: context.accountIdentifier,
        clientIp,
        ...(context.action !== undefined ? { action: context.action } : {}),
        ...(context.namespace !== undefined ? { namespace: context.namespace } : {}),
      }),
    ]);
  }
}
