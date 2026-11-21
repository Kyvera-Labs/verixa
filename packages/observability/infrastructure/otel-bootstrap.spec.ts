import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";

import {
  OTEL_RESOURCE_ATTRIBUTES,
  assertBootstrapLoadOrder,
  getActiveMemorySpanExporter,
  getActiveResourceAttributes,
  initOtelBootstrap,
  isOtelActive,
  resolveResourceAttributes,
  shutdownOtel,
} from "./otel-bootstrap.js";

describe("OpenTelemetry SDK Bootstrap", () => {
  afterEach(async () => {
    await shutdownOtel();
  });

  describe("test environment no-op behavior", () => {
    it("is disabled cleanly in test environment to avoid noisy CI output", () => {
      // Vitest sets NODE_ENV=test
      const result = initOtelBootstrap();

      expect(result.active).toBe(false);
      expect(result.reason).toBe("disabled_in_test_environment");
      expect(isOtelActive()).toBe(false);
      expect(result.sdk).toBeUndefined();
    });

    it("respects explicit disabled flag", () => {
      const result = initOtelBootstrap({ disabled: true, forceEnable: true });

      expect(result.active).toBe(false);
      expect(isOtelActive()).toBe(false);
    });
  });

  describe("active initialization and resource attributes", () => {
    it("initializes active SDK when forced in test environment and sets resource attributes", () => {
      const result = initOtelBootstrap({
        forceEnable: true,
        serviceName: "verixa-auth-service",
        serviceVersion: "1.2.3",
        environment: "staging",
        deploymentId: "deploy-xyz-987",
      });

      expect(result.active).toBe(true);
      expect(isOtelActive()).toBe(true);
      expect(result.sdk).toBeDefined();

      const attributes = result.attributes;
      expect(attributes[OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME]).toBe("verixa-auth-service");
      expect(attributes[OTEL_RESOURCE_ATTRIBUTES.SERVICE_VERSION]).toBe("1.2.3");
      expect(attributes[OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT]).toBe("staging");
      expect(attributes[OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ID]).toBe("deploy-xyz-987");
      expect(attributes[OTEL_RESOURCE_ATTRIBUTES.SERVICE_INSTANCE_ID]).toBe("deploy-xyz-987");

      expect(getActiveResourceAttributes()).toEqual(attributes);
    });

    it("emits spans with active tracer and resource attributes", async () => {
      initOtelBootstrap({
        forceEnable: true,
        serviceName: "verixa-test",
        serviceVersion: "1.0.0",
      });

      const tracer = trace.getTracer("smoke-test-tracer");
      const span = tracer.startSpan("smoke-span");
      span.setAttribute("test.attribute", "value");
      span.end();

      // Wait a brief tick for the span processor to export the span
      await new Promise((resolve) => setTimeout(resolve, 20));

      const memoryExporter = getActiveMemorySpanExporter();
      expect(memoryExporter).toBeDefined();
      const finishedSpans = memoryExporter!.getFinishedSpans();
      expect(finishedSpans.length).toBeGreaterThan(0);
      const finished = finishedSpans[0];
      expect(finished).toBeDefined();
      expect(finished!.name).toBe("smoke-span");
      expect(finished!.resource.attributes[OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME]).toBe(
        "verixa-test",
      );
      expect(finished!.resource.attributes[OTEL_RESOURCE_ATTRIBUTES.SERVICE_VERSION]).toBe("1.0.0");
    });
  });

  describe("load order verification", () => {
    it("assertBootstrapLoadOrder succeeds when OTel boots before app modules", () => {
      const bootstrapResult = initOtelBootstrap({ forceEnable: true });
      expect(bootstrapResult.active).toBe(true);

      const appModuleLoadTime = Date.now() + 100;
      expect(assertBootstrapLoadOrder(appModuleLoadTime)).toBe(true);
    });

    it("assertBootstrapLoadOrder fails when app modules load before OTel bootstrap", () => {
      initOtelBootstrap({ forceEnable: true });
      const previousLoadTime = Date.now() - 1000;

      expect(() => {
        assertBootstrapLoadOrder(previousLoadTime);
      }).toThrow(/load order violation/);
    });
  });

  describe("attribute resolution defaults", () => {
    it("provides fallback defaults when environment variables are missing", () => {
      const attrs = resolveResourceAttributes();

      expect(typeof attrs[OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME]).toBe("string");
      expect(attrs[OTEL_RESOURCE_ATTRIBUTES.SERVICE_NAME].length).toBeGreaterThan(0);
      expect(typeof attrs[OTEL_RESOURCE_ATTRIBUTES.SERVICE_VERSION]).toBe("string");
      expect(typeof attrs[OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ENVIRONMENT]).toBe("string");
      expect(typeof attrs[OTEL_RESOURCE_ATTRIBUTES.DEPLOYMENT_ID]).toBe("string");
    });
  });
});
