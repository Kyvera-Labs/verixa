import { NoopMetricsRecorder, PrometheusMetricsRecorder } from "@verixa/observability";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "../app.js";

import {
  DEFAULT_HTTP_IN_FLIGHT_REQUESTS_METRIC,
  DEFAULT_HTTP_REQUEST_DURATION_METRIC,
  DEFAULT_HTTP_REQUESTS_TOTAL_METRIC,
  getStatusCodeClass,
  registerHttpMetrics,
  resolveRouteTemplate,
} from "./http-metrics.js";

describe("HTTP Metrics Middleware (Issue 349 / #461)", () => {
  describe("utility functions", () => {
    it("getStatusCodeClass maps status codes to correct classes", () => {
      expect(getStatusCodeClass(200)).toBe("2xx");
      expect(getStatusCodeClass(201)).toBe("2xx");
      expect(getStatusCodeClass(204)).toBe("2xx");
      expect(getStatusCodeClass(301)).toBe("3xx");
      expect(getStatusCodeClass(302)).toBe("3xx");
      expect(getStatusCodeClass(400)).toBe("4xx");
      expect(getStatusCodeClass(401)).toBe("4xx");
      expect(getStatusCodeClass(404)).toBe("4xx");
      expect(getStatusCodeClass(500)).toBe("5xx");
      expect(getStatusCodeClass(503)).toBe("5xx");
      expect(getStatusCodeClass(99)).toBe("unknown");
    });

    it("resolveRouteTemplate prefers Fastify route schema over raw path", () => {
      const mockWithRoute = {
        routeOptions: { url: "/users/:id" },
        raw: { url: "/users/12345" },
      } as unknown as FastifyRequest;
      expect(resolveRouteTemplate(mockWithRoute)).toBe("/users/:id");

      const mockUnmatched = {
        routeOptions: { url: undefined },
        raw: { url: "/unmatched/path" },
      } as unknown as FastifyRequest;
      expect(resolveRouteTemplate(mockUnmatched)).toBe(":unmatched");
    });
  });

  describe("integration with buildApp", () => {
    it("records golden signal metrics across routes automatically", async () => {
      const recorder = new NoopMetricsRecorder();
      const app = buildApp({ metricsRecorder: recorder });

      // Send 3 requests to /health
      for (let i = 0; i < 3; i++) {
        const response = await app.inject({
          method: "GET",
          url: "/health",
        });
        expect(response.statusCode).toBe(200);
      }

      // Assert counter calls
      const healthCounterCalls = recorder.recordedCounters.filter(
        (c) =>
          c.name === DEFAULT_HTTP_REQUESTS_TOTAL_METRIC &&
          c.labels?.route === "/health" &&
          c.labels?.method === "GET" &&
          c.labels?.status_class === "2xx",
      );
      expect(healthCounterCalls).toHaveLength(3);
      expect(
        recorder.getCounter(DEFAULT_HTTP_REQUESTS_TOTAL_METRIC, {
          route: "/health",
          method: "GET",
          status_class: "2xx",
        }),
      ).toBe(3);

      // Assert duration histogram recorded
      const healthHistogramObservations = recorder.getHistogramObservations(
        DEFAULT_HTTP_REQUEST_DURATION_METRIC,
        {
          route: "/health",
          method: "GET",
          status_class: "2xx",
        },
      );
      expect(healthHistogramObservations).toHaveLength(3);
      for (const observation of healthHistogramObservations) {
        expect(observation).toBeGreaterThan(0);
        expect(observation).toBeLessThan(5); // Sub-second in-memory duration
      }

      // Assert in-flight gauge returns to 0 when idle
      expect(recorder.getGauge(DEFAULT_HTTP_IN_FLIGHT_REQUESTS_METRIC)).toBe(0);

      await app.close();
    });

    it("bounds cardinality on parameterized routes using Fastify route schema, never raw path", async () => {
      const recorder = new NoopMetricsRecorder();
      const app = Fastify();

      registerHttpMetrics(app, { recorder });

      app.get("/organizations/:orgId/members/:memberId", async (_req, reply) => {
        return reply.status(200).send({ ok: true });
      });

      // Issue requests with differing raw path parameters
      await app.inject({
        method: "GET",
        url: "/organizations/org_123/members/usr_abc",
      });
      await app.inject({
        method: "GET",
        url: "/organizations/org_456/members/usr_def",
      });
      await app.inject({
        method: "GET",
        url: "/organizations/org_789/members/usr_ghi",
      });

      // The recorded route must strictly be the parameterized template
      const totalCount = recorder.getCounter(DEFAULT_HTTP_REQUESTS_TOTAL_METRIC, {
        route: "/organizations/:orgId/members/:memberId",
        method: "GET",
        status_class: "2xx",
      });
      expect(totalCount).toBe(3);

      // Raw URLs must never appear as label values
      const forbiddenRawLabels = recorder.recordedCounters.filter(
        (c) =>
          c.labels?.route === "/organizations/org_123/members/usr_abc" ||
          c.labels?.route === "/organizations/org_456/members/usr_def",
      );
      expect(forbiddenRawLabels).toHaveLength(0);

      await app.close();
    });

    it("captures 4xx errors and bounds unmatched route cardinality", async () => {
      const recorder = new NoopMetricsRecorder();
      const app = buildApp({ metricsRecorder: recorder });

      const response = await app.inject({
        method: "GET",
        url: "/non-existent-unregistered-endpoint-987654",
      });
      expect(response.statusCode).toBe(404);

      const unmatchedCount = recorder.getCounter(DEFAULT_HTTP_REQUESTS_TOTAL_METRIC, {
        route: ":unmatched",
        method: "GET",
        status_class: "4xx",
      });
      expect(unmatchedCount).toBe(1);

      await app.close();
    });

    it("captures 5xx errors correctly", async () => {
      const recorder = new NoopMetricsRecorder();
      const app = Fastify();

      registerHttpMetrics(app, { recorder });

      app.get("/faulty", () => {
        throw new Error("Synthetic failure");
      });

      const response = await app.inject({
        method: "GET",
        url: "/faulty",
      });
      expect(response.statusCode).toBe(500);

      const failureCount = recorder.getCounter(DEFAULT_HTTP_REQUESTS_TOTAL_METRIC, {
        route: "/faulty",
        method: "GET",
        status_class: "5xx",
      });
      expect(failureCount).toBe(1);

      await app.close();
    });
  });

  describe("compatibility with Prometheus adapter", () => {
    it("records valid Prometheus scrape output with latency buckets and counts", async () => {
      const prometheusRecorder = new PrometheusMetricsRecorder();
      prometheusRecorder.clear();
      const app = Fastify();

      registerHttpMetrics(app, { recorder: prometheusRecorder });

      app.get("/items/:id", async (_req, reply) => {
        return reply.status(200).send({ item: 1 });
      });

      await app.inject({ method: "GET", url: "/items/1" });
      await app.inject({ method: "GET", url: "/items/2" });

      const metricsExposition = await prometheusRecorder.metrics();

      expect(metricsExposition).toContain("# TYPE verixa_http_requests_total counter");
      expect(metricsExposition).toContain(
        'verixa_http_requests_total{method="GET",route="/items/:id",status_class="2xx"} 2',
      );
      expect(metricsExposition).toContain("# TYPE verixa_http_request_duration_seconds histogram");
      expect(metricsExposition).toContain(
        'verixa_http_request_duration_seconds_bucket{le="0.1",method="GET",route="/items/:id",status_class="2xx"}',
      );
      expect(metricsExposition).toContain("# TYPE verixa_http_in_flight_requests gauge");

      await app.close();
    });
  });
});
