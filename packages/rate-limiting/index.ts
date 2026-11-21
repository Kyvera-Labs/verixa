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

// Domain (Issue 313 / 281)
export {
  TokenBucket,
  type TokenBucketOptions,
  type ConsumeResult as TokenBucketConsumeResult,
  type Clock,
} from "./domain/token-bucket.js";

// Infrastructure (Issue 314 / 282)
export {
  RedisBucketStore,
  type RedisBucketStoreOptions,
  type ConsumeParams,
  type BucketConsumeResult,
  CONSUME_BUCKET_LUA,
} from "./infrastructure/redis-bucket-store.js";

// Application Policy (Issue 315 / 284)
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

// Application Allowlist (Issue 304 / 289)
export {
  RateLimitAllowlist,
  type RateLimitAllowlistOptions,
  type AllowlistCheckSubject,
  type AllowlistCheckResult,
  type AllowlistBypassEvent,
  matchIpv4Cidr,
  matchIpv6Cidr,
} from "./application/allowlist.js";
