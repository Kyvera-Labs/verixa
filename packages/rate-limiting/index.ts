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

export {
  IpRateLimitStrategy,
  InMemoryRateLimiter,
  extractClientIp,
  type HttpRequestContext,
  type IpRateLimitStrategyOptions,
  type IpRateLimitContext,
  type IpRateLimitResult,
} from "./application/strategies/ip-strategy.js";
