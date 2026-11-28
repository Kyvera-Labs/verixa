import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

/**
 * Receives Content-Security-Policy violation reports, so blocked scripts and pages broken by a
 * tightened policy leave a trace.
 */

/**
 * Browsers send reports as JSON under this media type, which Fastify has no
 * built-in parser for — an unparsed content type is a 415, and the failure is
 * invisible: the browser does not retry, and nobody learns that the reporting
 * channel never worked.
 */
const CSP_REPORT_MEDIA_TYPE = "application/csp-report";

/**
 * Ceiling on a single report.
 *
 * `original-policy` echoes the whole policy back, so a report is a few
 * hundred bytes for this API — but the endpoint is unauthenticated and
 * repeatable by anyone with a browser, and Fastify's default body limit is
 * 1MB. Twelve times less, on an endpoint whose only writer is an automated
 * client with nothing to say beyond a few strings.
 */
const MAX_REPORT_BYTES = 16_384;

/**
 * Fields this endpoint understands. Unlike other schemas it allows unknown properties, because
 * reports come from browsers that send fields we do not model, and those fields are often the
 * evidence.
 */
const reportSchema = {
  type: "object",
  required: ["csp-report"],
  properties: {
    "csp-report": {
      type: "object",
      required: ["document-uri"],
      properties: {
        "document-uri": { type: "string" },
        "violated-directive": { type: "string" },
        "effective-directive": { type: "string" },
        "blocked-uri": { type: "string" },
        "original-policy": { type: "string" },
        disposition: { type: "string" },
        "source-file": { type: "string" },
        "line-number": { type: "number" },
        "column-number": { type: "number" },
        "status-code": { type: "number" },
      },
    },
  },
} as const;

interface CspReportBody {
  "csp-report"?: {
    "document-uri"?: string;
    "violated-directive"?: string;
    "effective-directive"?: string;
    "blocked-uri"?: string;
    "original-policy"?: string;
    disposition?: string;
    "source-file"?: string;
    "line-number"?: number;
    "column-number"?: number;
    "status-code"?: number;
  };
}

/**
 * The subset of a report worth keeping, as a plain object.
 *
 * Built field by field rather than by spreading the body: the values are
 * attacker-controlled strings on an unauthenticated endpoint, and a log line
 * assembled from a fixed field list says exactly what this system is willing
 * to repeat. `original-policy` in particular is the policy the browser saw —
 * useful, and the one field that would echo a forged value back at length.
 */
function summarize(report: CspReportBody["csp-report"]): Record<string, string | number> {
  const {
    "document-uri": documentUri,
    "effective-directive": effectiveDirective,
    "violated-directive": violatedDirective,
    "blocked-uri": blockedUri,
    disposition,
    "source-file": sourceFile,
    "status-code": statusCode,
  } = report ?? {};

  // `effective-directive` is the modern field and `violated-directive` the
  // legacy one; engines differ, so the legacy spelling stands in when it is all
  // a browser sends.
  const directive = effectiveDirective ?? violatedDirective;

  const summary: Record<string, string | number> = {
    documentUri: documentUri ?? "unknown",
  };

  // Named, literal fields only — there is no loop here on purpose. A fixed
  // field list is what makes "the log line cannot echo something the sender
  // invented" true by construction rather than by review.
  if (directive !== undefined) summary["directive"] = directive;
  if (blockedUri !== undefined) summary["blockedUri"] = blockedUri;
  if (disposition !== undefined) summary["disposition"] = disposition;
  if (sourceFile !== undefined) summary["sourceFile"] = sourceFile;
  if (statusCode !== undefined) summary["statusCode"] = statusCode;

  return summary;
}

/**
 * Register the endpoint, and the content type parser it needs.
 *
 * No container: reporting is about the server's policy, not a tenant's data,
 * and it must work wherever the policy is being served — including on a
 * process with no database wired.
 */
export function registerCspReportRoute<TLogger extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
): void {
  // The explicit type argument is what pins `body` to `string`: Fastify
  // infers `parseAs` from the parser's own signature, so a callback with an
  // untyped parameter would be handed `string | Buffer`.
  app.addContentTypeParser<string>(
    CSP_REPORT_MEDIA_TYPE,
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        done(null, JSON.parse(body) as unknown);
      } catch {
        // 400 rather than a fall-through: the sender is a browser, and a
        // malformed report is a malformed report. The message is fixed and says
        // nothing about the payload.
        const error: Error & { statusCode?: number } = new Error(
          "CSP report body is not well-formed JSON.",
        );
        error.statusCode = 400;
        done(error);
      }
    },
  );

  app.post<{ Body: CspReportBody }>(
    "/csp-report",
    { schema: { body: reportSchema }, bodyLimit: MAX_REPORT_BYTES },
    async (request, reply) => {
      // Logged, not stored. A violation is a signal about a page and a policy,
      // and the place that signal belongs is the same stream every other
      // operational event goes to. Turning it into a table is a later
      // security-monitoring question, not this endpoint's.
      request.log.info(
        { cspReport: summarize(request.body["csp-report"]) },
        "content security policy violation reported",
      );

      // 204: the browser ignores the response body, and a 200 with `{}` would
      // be a second shape for "nothing in particular to report".
      await reply.status(204).send();
    },
  );
}
