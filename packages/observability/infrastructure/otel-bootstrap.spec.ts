import { loadConfig } from "@verixa/config";
import { describe, expect, it, vi } from "vitest";

import {
  bootstrapOtel,
  ErrorAwareRatioSampler,
  NoopSpanExporter,
  OtelBootstrapError,
  OtlpSpanExporter,
  otelConfigFromAppConfig,
  type SpanExporter,
  type SpanRecord,
} from "./otel-bootstrap.js";

const VALID_SECRET = "a".repeat(32);

function makeSpan(overrides: Partial<SpanRecord> = {}): SpanRecord {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "http.request",
    startTimeUnixNano: 1_000_000n,
    endTimeUnixNano: 2_000_000n,
    status: { code: "OK" },
    ...overrides,
  };
}

describe("ErrorAwareRatioSampler", () => {
  it("always force-samples error spans even when samplingRate is 0", () => {
    const sampler = new ErrorAwareRatioSampler(0, () => 0.99);
    const errorSpan = makeSpan({ status: { code: "ERROR", message: "db timeout" } });

    expect(sampler.shouldSample(errorSpan)).toEqual({
      sampled: true,
      reason: "error-force-sampled",
    });
  });

  it("samples 100% of non-error spans when samplingRate is 1", () => {
    const sampler = new ErrorAwareRatioSampler(1, () => 0.9999);
    const okSpan = makeSpan({ status: { code: "OK" } });

    expect(sampler.shouldSample(okSpan)).toEqual({
      sampled: true,
      reason: "rate-sampled",
    });
  });

  it("drops non-error spans when samplingRate is 0", () => {
    const sampler = new ErrorAwareRatioSampler(0, () => 0);
    const okSpan = makeSpan({ status: { code: "OK" } });

    expect(sampler.shouldSample(okSpan)).toEqual({
      sampled: false,
      reason: "rate-dropped",
    });
  });

  it("applies probabilistic sampling for fractional rates", () => {
    const okSpan = makeSpan({ status: { code: "OK" } });

    const sampled = new ErrorAwareRatioSampler(0.1, () => 0.05).shouldSample(okSpan);
    const dropped = new ErrorAwareRatioSampler(0.1, () => 0.5).shouldSample(okSpan);

    expect(sampled).toEqual({ sampled: true, reason: "rate-sampled" });
    expect(dropped).toEqual({ sampled: false, reason: "rate-dropped" });
  });

  it("rejects out-of-range sampling rates", () => {
    expect(() => new ErrorAwareRatioSampler(-0.01)).toThrowError(OtelBootstrapError);
    expect(() => new ErrorAwareRatioSampler(1.01)).toThrowError(OtelBootstrapError);
    expect(() => new ErrorAwareRatioSampler(Number.NaN)).toThrowError(OtelBootstrapError);
  });
});

describe("bootstrapOtel", () => {
  it("fails fast at startup on invalid exporter endpoint or protocol", () => {
    expect(() =>
      bootstrapOtel({
        environment: "production",
        serviceName: "verixa-api",
        endpoint: "not-a-valid-url",
        protocol: "http/protobuf",
        headers: {},
        samplingRate: 0.1,
      }),
    ).toThrowError(OtelBootstrapError);

    expect(() =>
      bootstrapOtel({
        environment: "production",
        serviceName: "verixa-api",
        endpoint: "http://localhost:4318",
        protocol: "udp" as unknown as "http/protobuf",
        headers: {},
        samplingRate: 0.1,
      }),
    ).toThrowError(OtelBootstrapError);
  });

  it("disables export cleanly in test environments", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SECRET,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });

    const handle = bootstrapOtel(otelConfigFromAppConfig(config));

    expect(handle.enabled).toBe(false);
    expect(handle.exporter).toBeInstanceOf(NoopSpanExporter);
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("exports error spans even when production sampling rate is 0", async () => {
    const exported: SpanRecord[] = [];
    const memoryExporter: SpanExporter = {
      export(spans) {
        exported.push(...spans);
        return Promise.resolve();
      },
      shutdown() {
        return Promise.resolve();
      },
    };

    const config = loadConfig({
      NODE_ENV: "production",
      SESSION_ACCESS_TOKEN_SECRET: VALID_SECRET,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com:4318",
      OTEL_TRACES_SAMPLER_RATE: "0",
    });

    const handle = bootstrapOtel(
      otelConfigFromAppConfig(config, { exporter: memoryExporter, random: () => 0.99 }),
    );

    const okDecision = await handle.recordSpan(makeSpan({ name: "ok-op", status: { code: "OK" } }));
    const errDecision = await handle.recordSpan(
      makeSpan({ name: "err-op", status: { code: "ERROR", message: "boom" } }),
    );

    expect(okDecision).toEqual({ sampled: false, reason: "rate-dropped" });
    expect(errDecision).toEqual({ sampled: true, reason: "error-force-sampled" });
    expect(exported).toHaveLength(1);
    expect(exported[0]?.name).toBe("err-op");
  });

  it("sends OTLP HTTP requests with configured headers and resource attributes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const exporter = new OtlpSpanExporter({
      endpoint: "https://collector.example.com:4318",
      protocol: "http/json",
      headers: { Authorization: "Bearer test-token" },
      resource: {
        "service.name": "verixa-api",
        "service.version": "0.1.0",
        "deployment.environment": "production",
      },
      fetchImpl: fetchMock,
    });

    await exporter.export([makeSpan()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://collector.example.com:4318/v1/traces");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      Authorization: "Bearer test-token",
    });
  });
});
