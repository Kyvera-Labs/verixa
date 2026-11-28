import { buildApp } from "@verixa/api/app";
import { createLogger } from "@verixa/shared-kernel";
import supertest from "supertest";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `POST /csp-report`. Captures the log stream to confirm a violation report arrives in a readable
 * form, not just that the endpoint answers 204. Builds the app with a logger instead of using
 * `helpers/http-client.js`, which takes a container.
 */

interface CapturedLine {
  level: number;
  msg?: string;
  cspReport?: Record<string, string | number>;
  [key: string]: unknown;
}

function captureLogs() {
  const lines: CapturedLine[] = [];
  const logger = createLogger(
    { name: "csp-report-test", level: "info" },
    {
      write(chunk: string) {
        for (const line of chunk.split("\n")) {
          if (line.trim() === "") continue;
          lines.push(JSON.parse(line) as CapturedLine);
        }
      },
    },
  );

  return { logger, lines };
}

/** The shape a browser actually sends. */
const REPORT = {
  "csp-report": {
    "document-uri": "https://verixa.example/docs",
    referrer: "",
    "blocked-uri": "https://evil.example/script.js",
    "violated-directive": "script-src 'self' 'nonce-abc'",
    "effective-directive": "script-src",
    "original-policy": "default-src 'self'; script-src 'self'; report-uri /csp-report",
    disposition: "enforce",
    "script-sample": "",
    "status-code": 200,
  },
};

describe("POST /csp-report", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function client() {
    const captured = captureLogs();
    const app = buildApp({ logger: captured.logger });
    await app.ready();
    close = () => app.close();

    return { ...captured, request: supertest(app.server) };
  }

  /**
   * Post the way a browser does: JSON text under the `application/csp-report`
   * media type. The payload is stringified rather than handed to supertest as
   * an object because superagent only serializes objects it is sending as
   * `application/json` — an object under any other content type reaches Node's
   * http layer as a value it cannot write.
   */
  function postReport(request: ReturnType<typeof supertest>, payload: unknown) {
    return request
      .post("/csp-report")
      .set("Content-Type", "application/csp-report")
      .send(JSON.stringify(payload));
  }

  it("accepts a browser's report and records it", async () => {
    const { request, lines } = await client();

    const response = await postReport(request, REPORT);

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});

    const recorded = lines.find((line) => line.cspReport !== undefined);
    expect(recorded?.msg).toBe("content security policy violation reported");
    expect(recorded?.cspReport).toMatchObject({
      documentUri: "https://verixa.example/docs",
      directive: "script-src",
      blockedUri: "https://evil.example/script.js",
      disposition: "enforce",
    });
  });

  it("keeps a report whose only directive field is the legacy one", async () => {
    const { request, lines } = await client();

    await postReport(request, {
      "csp-report": { "document-uri": "https://x/", "violated-directive": "img-src 'self'" },
    });

    expect(lines.find((line) => line.cspReport !== undefined)?.cspReport?.["directive"]).toBe(
      "img-src 'self'",
    );
  });

  it("tolerates fields it does not model", async () => {
    const { request, lines } = await client();

    // Unlike every other endpoint in this API, which rejects unknown
    // properties: the sender here is a browser, and dropping a report because
    // an engine added `sample` to it loses the evidence, not the argument.
    const response = await postReport(request, {
      "csp-report": { "document-uri": "https://x/", some_future_field: "value" },
    });

    expect(response.status).toBe(204);
    expect(lines.some((line) => line.cspReport !== undefined)).toBe(true);
  });

  it("does not echo the policy back into the log line", async () => {
    const { request, lines } = await client();

    await postReport(request, REPORT);

    // `original-policy` is the single largest attacker-influenced string in a
    // report, and this endpoint is unauthenticated.
    const serialized = JSON.stringify(lines.find((line) => line.cspReport !== undefined));
    expect(serialized).not.toContain("original-policy");
    expect(serialized).not.toContain("default-src 'self'; script-src 'self'");
  });

  it("rejects a body with no report in it", async () => {
    const { request, lines } = await client();

    const response = await postReport(request, { unexpected: true });

    expect(response.status).toBe(400);
    expect(lines.some((line) => line.cspReport !== undefined)).toBe(false);
  });

  it("rejects a report with no document-uri", async () => {
    const { request } = await client();

    const response = await postReport(request, {
      "csp-report": { "blocked-uri": "https://evil.example" },
    });

    expect(response.status).toBe(400);
  });

  it("rejects a body that is not JSON, with a 400 rather than a 500", async () => {
    const { request } = await client();

    const response = await request
      .post("/csp-report")
      .set("Content-Type", "application/csp-report")
      .send("<html>not a report</html>");

    expect(response.status).toBe(400);
  });

  it("refuses a report larger than the endpoint's ceiling", async () => {
    const { request, lines } = await client();

    // The endpoint is unauthenticated and its only legitimate writer sends a
    // few hundred bytes.
    const padded = {
      "csp-report": { "document-uri": `https://x/${"y".repeat(64 * 1024)}` },
    };

    const response = await postReport(request, padded);

    expect(response.status).toBe(413);
    expect(lines.some((line) => line.cspReport !== undefined)).toBe(false);
  });

  it("still accepts the same report posted as ordinary JSON", async () => {
    const { request, lines } = await client();

    // Fastify parses `application/json` on its own, and a research tool or a
    // manual `curl` is far more likely to use it than the browser-only media
    // type. Accepting both costs nothing and makes the channel testable by
    // hand.
    const response = await request.post("/csp-report").send(REPORT);

    expect(response.status).toBe(204);
    expect(lines.some((line) => line.cspReport !== undefined)).toBe(true);
  });
});
