import type { MetricsRecorder } from "@verixa/observability";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

export const DEFAULT_HTTP_REQUESTS_TOTAL_METRIC = "verixa_http_requests_total";
export const DEFAULT_HTTP_REQUEST_DURATION_METRIC = "verixa_http_request_duration_seconds";
export const DEFAULT_HTTP_IN_FLIGHT_REQUESTS_METRIC = "verixa_http_in_flight_requests";

/** WeakMap holding high-resolution monotonic start times per request. */
const requestStartTimes = new WeakMap<FastifyRequest, bigint>();

export interface HttpMetricsOptions {
  /** The MetricsRecorder instance used to record telemetry. */
  readonly recorder: MetricsRecorder;
  /** Counter metric name; defaults to 'verixa_http_requests_total'. */
  readonly requestsTotalMetricName?: string;
  /** Histogram metric name; defaults to 'verixa_http_request_duration_seconds'. */
  readonly durationMetricName?: string;
  /** Gauge metric name; defaults to 'verixa_http_in_flight_requests'. */
  readonly inFlightMetricName?: string;
  /**
   * Fallback route template used when the incoming request does not match any route schema.
   * Defaults to ':unmatched'.
   */
  readonly fallbackRouteTemplate?: string;
  /** Optional filter predicate to skip metrics recording for specific requests (e.g. /health). */
  readonly shouldSkip?: (request: FastifyRequest) => boolean;
}

/**
 * Returns the HTTP status code class ('1xx', '2xx', '3xx', '4xx', '5xx', or 'unknown').
 */
export function getStatusCodeClass(statusCode: number): string {
  if (statusCode >= 100 && statusCode < 200) return "1xx";
  if (statusCode >= 200 && statusCode < 300) return "2xx";
  if (statusCode >= 300 && statusCode < 400) return "3xx";
  if (statusCode >= 400 && statusCode < 500) return "4xx";
  if (statusCode >= 500 && statusCode < 600) return "5xx";
  return "unknown";
}

/**
 * Resolves the bounded route template for an incoming request.
 *
 * CRITICAL: Never returns the raw interpolated URL (e.g. `/users/123e4567...`) because
 * interpolated paths have unbounded cardinality and would quickly degrade timeseries storage.
 * If the route was not matched (404), returns the safe fallback string.
 */
export function resolveRouteTemplate(
  request: FastifyRequest,
  fallbackRouteTemplate = ":unmatched",
): string {
  const routeUrl = request.routeOptions?.url;
  if (routeUrl && routeUrl.length > 0) {
    return routeUrl;
  }
  return fallbackRouteTemplate;
}

/**
 * Registers Fastify request/response hooks to capture standard HTTP golden signals
 * (latency, traffic, errors, and saturation).
 *
 * Emits:
 * - Counter: `verixa_http_requests_total` { method, route, status_class }
 * - Histogram: `verixa_http_request_duration_seconds` { method, route, status_class }
 * - Gauge: `verixa_http_in_flight_requests` {}
 */
export function registerHttpMetrics<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  options: HttpMetricsOptions,
): void {
  const {
    recorder,
    requestsTotalMetricName = DEFAULT_HTTP_REQUESTS_TOTAL_METRIC,
    durationMetricName = DEFAULT_HTTP_REQUEST_DURATION_METRIC,
    inFlightMetricName = DEFAULT_HTTP_IN_FLIGHT_REQUESTS_METRIC,
    fallbackRouteTemplate = ":unmatched",
    shouldSkip,
  } = options;

  let inFlightRequests = 0;

  app.addHook("onRequest", (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
    if (shouldSkip && shouldSkip(request)) {
      done();
      return;
    }

    requestStartTimes.set(request, process.hrtime.bigint());
    inFlightRequests += 1;
    recorder.setGauge(inFlightMetricName, inFlightRequests);
    done();
  });

  app.addHook("onResponse", (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    if (shouldSkip && shouldSkip(request)) {
      done();
      return;
    }

    const rawStartTime = requestStartTimes.get(request);
    if (rawStartTime !== undefined) {
      const elapsedNs = process.hrtime.bigint() - rawStartTime;
      const durationSeconds = Number(elapsedNs) / 1e9;

      const method = request.method.toUpperCase();
      const route = resolveRouteTemplate(request, fallbackRouteTemplate);
      const statusClass = getStatusCodeClass(reply.statusCode);

      const labels = {
        method,
        route,
        status_class: statusClass,
      };

      recorder.recordHistogram(durationMetricName, durationSeconds, labels);
      recorder.incrementCounter(requestsTotalMetricName, 1, labels);
    }

    inFlightRequests = Math.max(0, inFlightRequests - 1);
    recorder.setGauge(inFlightMetricName, inFlightRequests);
    done();
  });
}
