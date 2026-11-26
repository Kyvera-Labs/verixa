import { trace, type Span } from "@opentelemetry/api";
import { describe, expect, it, vi } from "vitest";

import {
  bindRequestContext,
  clearRequestContext,
  getActiveTraceId,
  getCorrelationId,
  getRequestContext,
  getTraceId,
  runWithRequestContext,
} from "./request-context.js";

describe("RequestContext via AsyncLocalStorage", () => {
  it("returns undefined for context getters when outside of request context", () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getCorrelationId()).toBeUndefined();
    expect(getTraceId()).toBeUndefined();
    expect(getActiveTraceId()).toBeUndefined();
  });

  it("safely ignores bindRequestContext when called outside of context", () => {
    expect(() => {
      bindRequestContext({ actorId: "actor-123" });
    }).not.toThrow();
    expect(getRequestContext()).toBeUndefined();
  });

  it("propagates correlationId and traceId across synchronous and asynchronous operations", async () => {
    const context = {
      correlationId: "corr-test-1",
      traceId: "trace-test-1",
      route: "/users/:id",
    };

    await runWithRequestContext(context, async () => {
      expect(getRequestContext()).toBeDefined();
      expect(getCorrelationId()).toBe("corr-test-1");
      expect(getTraceId()).toBe("trace-test-1");
      expect(getActiveTraceId()).toBe("trace-test-1");

      // Nested async boundary (microtask / setTimeout)
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(getCorrelationId()).toBe("corr-test-1");
          expect(getTraceId()).toBe("trace-test-1");
          resolve();
        }, 10);
      });
    });

    // Outside context again
    expect(getRequestContext()).toBeUndefined();
  });

  it("isolates context across concurrent asynchronous requests without leaking", async () => {
    const runSimulatedRequest = async (id: number, durationMs: number) => {
      const correlationId = `req-uuid-${id}`;
      const traceId = `trace-uuid-${id}`;

      return runWithRequestContext({ correlationId, traceId }, async () => {
        // Yield execution to allow interleaving with concurrent requests
        await new Promise((r) => setTimeout(r, durationMs));
        expect(getCorrelationId()).toBe(correlationId);
        expect(getTraceId()).toBe(traceId);
        return { correlationId: getCorrelationId(), traceId: getTraceId() };
      });
    };

    // Run 20 concurrent requests with staggered durations
    const promises = Array.from({ length: 20 }, (_, idx) =>
      runSimulatedRequest(idx, (idx % 5) * 5 + 1),
    );

    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    results.forEach((res, idx) => {
      expect(res.correlationId).toBe(`req-uuid-${idx}`);
      expect(res.traceId).toBe(`trace-uuid-${idx}`);
    });
  });

  it("allows binding additional attributes to existing context", () => {
    runWithRequestContext({ correlationId: "initial-corr" }, () => {
      expect(getCorrelationId()).toBe("initial-corr");
      expect(getRequestContext()?.actorId).toBeUndefined();

      bindRequestContext({
        actorId: "user-456",
        traceId: "trace-456",
      });

      expect(getRequestContext()?.actorId).toBe("user-456");
      expect(getTraceId()).toBe("trace-456");
      expect(getActiveTraceId()).toBe("trace-456");
    });
  });

  it("can clear context with clearRequestContext", () => {
    runWithRequestContext({ correlationId: "will-clear" }, () => {
      expect(getCorrelationId()).toBe("will-clear");
      clearRequestContext();
      expect(getRequestContext()).toBeUndefined();
    });
  });

  it("extracts traceId from active OpenTelemetry span when context traceId is absent", () => {
    const validTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const getActiveSpanSpy = vi.spyOn(trace, "getActiveSpan").mockReturnValue({
      spanContext: () => ({
        traceId: validTraceId,
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      }),
    } as unknown as Span);

    try {
      // Inside a request context without explicit traceId
      runWithRequestContext({ correlationId: "corr-no-trace" }, () => {
        expect(getTraceId()).toBeUndefined();
        expect(getActiveTraceId()).toBe(validTraceId);
      });

      // Outside request context
      expect(getActiveTraceId()).toBe(validTraceId);
    } finally {
      getActiveSpanSpy.mockRestore();
    }
  });
});
