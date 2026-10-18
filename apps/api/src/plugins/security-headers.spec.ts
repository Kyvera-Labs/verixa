import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { renderHtmlDocument } from "../http/html.js";

/**
 * The nonce-based Content-Security-Policy (Issue 212).
 *
 * These tests exercise the policy over real HTTP rather than by reading the
 * directive string, because the thing worth proving is that a response
 * actually carries the header, that its nonce matches the document it is
 * describing, and that the two change together. A unit test of a string
 * builder would keep passing after someone registered the hook on the wrong
 * instance.
 *
 * An HTML route is added here rather than found in the app: `apps/api` serves
 * JSON today, and the surfaces this policy is written for — Issue 237's
 * Swagger UI, admin pages — do not exist yet. The probe is the first consumer
 * of `renderHtmlDocument`, which is the point of having the seam at all.
 */

const PROBE_PATH = "/__probe.html";

describe("security headers (Issue 212)", () => {
  const app = buildApp();

  beforeAll(async () => {
    app.get(PROBE_PATH, (request, reply) => {
      void reply
        .type("text/html; charset=utf-8")
        .send(
          renderHtmlDocument({
            title: "Probe",
            body: "<p>hello</p>",
            cspNonce: request.cspNonce,
            inlineScript: "document.title = 'probed';",
          }),
        );
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  /** Pull the nonce out of a `script-src` directive. */
  function nonceFrom(header: string | undefined): string | undefined {
    return /script-src[^;]*'nonce-([^']+)'/.exec(header ?? "")?.[1];
  }

  it("gives an HTML response a nonce in script-src and no unsafe source expression", async () => {
    const response = await supertest(app.server).get(PROBE_PATH);

    const policy = response.headers["content-security-policy"] as string;
    expect(policy).toBeDefined();
    // The acceptance criterion, stated as the browser would enforce it: an
    // inline script runs only with this response's nonce.
    expect(policy).toContain(`'nonce-${nonceFrom(policy)}'`);
    expect(nonceFrom(policy)).toBeTruthy();
    // Both spellings, because `unsafe-inline` appears inside
    // `style-src-attr` and `default-src` too, and any one of them defeats the
    // nonce.
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).toContain("script-src 'self'");
  });

  it("threads the header's nonce into the rendered document's inline script", async () => {
    const response = await supertest(app.server).get(PROBE_PATH);

    const policy = response.headers["content-security-policy"] as string;
    const headerNonce = nonceFrom(policy);
    expect(headerNonce).toBeTruthy();

    // The two halves have to agree, or the script the policy permits is not
    // the script the document contains: a page whose inline script carries a
    // stale or hardcoded nonce is a page that does not run.
    expect(response.text).toContain(`<script nonce="${headerNonce}">`);
  });

  it("generates a fresh nonce per request", async () => {
    const first = await supertest(app.server).get(PROBE_PATH);
    const second = await supertest(app.server).get(PROBE_PATH);

    const a = nonceFrom(first.headers["content-security-policy"]);
    const b = nonceFrom(second.headers["content-security-policy"]);

    // A stable nonce is a constant an attacker can write into an injected
    // tag, which is `'unsafe-inline'` with extra steps.
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("uses a 128-bit base64url nonce", async () => {
    const response = await supertest(app.server).get(PROBE_PATH);
    const nonce = nonceFrom(response.headers["content-security-policy"]);

    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // 16 bytes base64-encoded without padding is 22 characters. Anything
    // shorter means the entropy went down, which no test would notice until a
    // nonce was guessed.
    expect(Buffer.from(nonce ?? "", "base64url").length).toBe(16);
  });

  it("applies a fail-closed policy to a JSON response", async () => {
    const response = await supertest(app.server).get("/health");

    const policy = response.headers["content-security-policy"] as string;
    // Nothing may load, so nothing is permitted to. If a bug ever makes this
    // endpoint return HTML, the markup cannot fetch or run anything.
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("points every policy at the report endpoint", async () => {
    for (const path of ["/health", PROBE_PATH]) {
      const response = await supertest(app.server).get(path);
      expect(response.headers["content-security-policy"] as string).toContain(
        "report-uri /csp-report",
      );
    }
  });

  it("sets the non-CSP security headers on every response", async () => {
    for (const path of ["/health", PROBE_PATH]) {
      const response = await supertest(app.server).get(path);

      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
    }
  });
});
