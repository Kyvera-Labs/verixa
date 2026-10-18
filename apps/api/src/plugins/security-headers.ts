import { randomBytes } from "node:crypto";

import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * Security headers, including the nonce-based Content-Security-Policy
 * (Issue 212, tightening the baseline described in Issue 203).
 *
 * The API is a JSON service today, but its HTML-serving surfaces — the
 * Swagger UI of Issue 237, whatever admin pages follow — are the reason this
 * exists before them: a surface added later under an
 * `unsafe-inline`-permitting policy is a surface nobody reopens to fix. The
 * seam is here now, and the first HTML route has to step through it.
 */

/**
 * 128 bits of entropy per response, base64url without padding.
 *
 * Padding-free so the value can never contain `=`, and url-safe so `/` and `+`
 * do not have to survive whatever logging, proxying or copy-pasting happens to
 * a response header on the way to a browser.
 */
function generateNonce(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * The policy for documents this server renders.
 *
 * `script-src 'self' 'nonce-...'` and nothing else. That is the entire point
 * of the exercise: `'unsafe-inline'` in `script-src` does not merely widen the
 * policy, it cancels it. CSP's core XSS defence is that an injected
 * `<script>alert(1)</script>` is not on the allowlist, and `'unsafe-inline'`
 * permits exactly that shape — every inline script, including the attacker's.
 * A nonce is the same convenience with the protection intact: the browser runs
 * an inline script only if it carries the value this response generated, which
 * an injected fragment cannot know unless the attacker can already read the
 * response.
 *
 * `'unsafe-eval'` is absent for the same kind of reason: it lets a string
 * become code, so any place an attacker can steer a string steers execution.
 * A documentation page needs neither.
 */
export function contentSecurityPolicyForHtml(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    // `data:` URIs in `script-src`/`img-src` are a known XSS stepping stone,
    // and nothing here needs them.
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "report-uri /csp-report",
  ].join("; ");
}

/**
 * The policy for everything that is not a document we render.
 *
 * `default-src 'none'` with no script source at all: a JSON body has no reason
 * to load anything, and if something has made the API return HTML, this is the
 * header that stops that HTML from executing. Fail-closed by construction —
 * a route that forgets to declare a content type gets the strict policy, not
 * the permissive one.
 */
export function contentSecurityPolicyForApi(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "report-uri /csp-report",
  ].join("; ");
}

/**
 * Every response carries these, whatever its content type.
 *
 * Kept next to the CSP rather than scattered across routes so there is one
 * list to review. Each is a fallback for a browser that does not honour the
 * CSP directive doing the same job.
 */
const FIXED_HEADERS: Readonly<Record<string, string>> = {
  // Stops a browser guessing that a JSON or text response is HTML and running
  // it as a script — the classic stored-XSS-via-a-mislabelled-upload path.
  "X-Content-Type-Options": "nosniff",
  // This service has no reason to tell a third-party origin where its users
  // came from; a full URL in `Referer` can carry a token or an identifier.
  "Referrer-Policy": "no-referrer",
  // Legacy `frame-ancestors 'none'`: honored by browsers that predate CSP2,
  // and harmless in the ones that do not.
  "X-Frame-Options": "DENY",
};

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The CSP nonce generated for this request.
     *
     * Set by the `onRequest` hook below and read by anything rendering an HTML
     * document — see `../http/html.js`. Decorated rather than passed as an
     * argument so a route cannot forget to thread it, and typed as always
     * present because `decorateRequest` gives every request the initial value
     * before any handler runs.
     */
    cspNonce: string;
  }
}

/**
 * Install the hooks.
 *
 * Called directly by `buildApp` rather than through `app.register`: the repo
 * has no plugin encapsulation to preserve (see `apps/api/src/routes/auth.ts`
 * for the same reasoning about route registration), and a nested scope would
 * apply these headers only to routes registered inside it — which is precisely
 * the failure mode where one route quietly goes unprotected.
 */
export function registerSecurityHeaders<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  app.decorateRequest("cspNonce", "");

  app.addHook("onRequest", async (request, reply) => {
    // Per request, never per process. A nonce that is the same on every
    // response is a static string an attacker can hardcode, which makes it
    // exactly as useful as `'unsafe-inline'` — the security value is entirely
    // in its unpredictability.
    request.cspNonce = generateNonce();

    for (const [name, value] of Object.entries(FIXED_HEADERS)) {
      reply.header(name, value);
    }
  });

  app.addHook("onSend", async (request, reply) => {
    if (reply.getHeader("content-security-policy") !== undefined) {
      // A route that set its own policy wins; overriding it here would be a
      // surprise to whoever wrote it.
      return;
    }

    const contentType = reply.getHeader("content-type");
    const isHtml =
      typeof contentType === "string" && contentType.split(";")[0]?.trim() === "text/html";

    // The decision needs the content type, which a route may only choose while
    // handling the request — so it happens here rather than in `onRequest`.
    reply.header(
      "Content-Security-Policy",
      isHtml ? contentSecurityPolicyForHtml(request.cspNonce) : contentSecurityPolicyForApi(),
    );
  });
}
