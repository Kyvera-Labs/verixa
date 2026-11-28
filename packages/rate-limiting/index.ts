export {
  CaptchaError,
  InvalidCaptchaTokenError,
  CaptchaTimeoutError,
  MalformedCaptchaResponseError,
  CaptchaServiceError,
  type CaptchaVerifier,
} from "./application/ports/captcha-verifier.js";

export {
  NoopCaptchaVerifier,
  type NoopCaptchaVerifierOptions,
} from "./infrastructure/adapters/noop-captcha-verifier.js";

export {
  HttpCaptchaVerifier,
  type HttpCaptchaVerifierConfig,
} from "./infrastructure/adapters/http-captcha-verifier.js";

export {
  GeoIpError,
  InvalidIpAddressError,
  GeoIpTimeoutError,
  MalformedGeoResponseError,
  GeoIpServiceError,
  type GeoIpResolver,
  type GeoLocation,
} from "./application/ports/geo-ip-resolver.js";

export {
  StaticGeoIpResolver,
  type StaticGeoIpResolverOptions,
} from "./infrastructure/adapters/static-geo-ip-resolver.js";

export {
  HttpGeoIpResolver,
  type HttpGeoIpResolverConfig,
} from "./infrastructure/adapters/http-geo-ip-resolver.js";

// Domain
export {
  TokenBucket,
  type TokenBucketOptions,
  type ConsumeResult as TokenBucketConsumeResult,
  type Clock,
} from "./domain/token-bucket.js";

// Infrastructure
export {
  RedisBucketStore,
  type RedisBucketStoreOptions,
  type ConsumeParams,
  type BucketConsumeResult,
  CONSUME_BUCKET_LUA,
} from "./infrastructure/redis-bucket-store.js";

// Application Policy
export {
  routePolicyConfigSchema,
  type RoutePolicyConfig,
  type RoutePolicyConfigInput,
  type ResolvedRoutePolicy,
  GENERAL_API_DEFAULT_POLICY,
  DEFAULT_ROUTE_POLICIES,
  normalizeRouteName,
  resolveRoutePolicy,
  RateLimitPolicyRegistry,
} from "./application/rate-limit-policy.js";

// Application Allowlist
export {
  RateLimitAllowlist,
  type RateLimitAllowlistOptions,
  type AllowlistCheckSubject,
  type AllowlistCheckResult,
  type AllowlistBypassEvent,
  matchIpv4Cidr,
  matchIpv6Cidr,
} from "./application/allowlist.js";

// Application Abuse Prevention & Strategies
export {
  CaptchaTriggerPolicy,
  type CaptchaTriggerPolicyOptions,
  type CaptchaSubject,
} from "./application/captcha-trigger-policy.js";

export {
  ImpossibleTravelDetector,
  type ImpossibleTravelDetectorOptions,
  type AnomalyFlag,
  calculateHaversineDistanceKm,
} from "./application/anomaly/impossible-travel-detector.js";

export {
  VolumeAnomalyDetector,
  type VolumeAnomalyDetectorOptions,
} from "./application/anomaly/volume-anomaly-detector.js";

export {
  IpRateLimitStrategy,
  InMemoryRateLimiter,
  extractClientIp,
  type HttpRequestContext,
  type IpRateLimitStrategyOptions,
  type IpRateLimitContext,
  type IpRateLimitResult,
} from "./application/strategies/ip-strategy.js";

export {
  AccountRateLimitStrategy,
  normalizeAccountIdentifier,
  type AccountRateLimitStrategyOptions,
  type AccountRateLimitContext,
  type AccountRateLimitResult,
} from "./application/strategies/account-strategy.js";

export {
  CompositeRateLimitStrategy,
  type CompositeRateLimitStrategyOptions,
  type CompositeRateLimitContext,
  type CompositeRateLimitResult,
  type RateLimitDenialReason,
} from "./application/strategies/composite-strategy.js";
