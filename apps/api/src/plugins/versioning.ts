import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

import { sendApiError } from "../http/error-response.js";

export interface VersioningOptions {
  /**
   * Supported major versions (e.g., ["v1"]).
   */
  readonly supportedVersions?: readonly string[];
  /**
   * Paths excluded from version prefix enforcement (e.g. ["/health", "/docs"]).
   */
  readonly excludedPaths?: readonly (string | RegExp)[];
}

declare module "fastify" {
  interface FastifyContextConfig {
    version?: string;
    deprecated?: boolean;
    sunset?: string | Date;
  }
}

const DEFAULT_SUPPORTED_VERSIONS = ["v1"] as const;

const DEFAULT_EXCLUDED_PATHS: readonly (string | RegExp)[] = [
  "/health",
  "/docs",
  /^\/docs(\/.*)?$/,
  "/favicon.ico",
];

function isPathExcluded(urlPath: string, exclusions: readonly (string | RegExp)[]): boolean {
  for (const exclusion of exclusions) {
    if (typeof exclusion === "string") {
      if (urlPath === exclusion || urlPath.startsWith(`${exclusion}/`)) {
        return true;
      }
    } else if (exclusion.test(urlPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Format a Date or HTTP date string to RFC 7231 / HTTP-date format.
 */
function toHttpDate(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(d.getTime()) ? String(date) : d.toUTCString();
}

/**
 * Fastify plugin enforcing URI versioning prefix (/v1/...) and managing route deprecation headers.
 */
const versioningPlugin: FastifyPluginAsync<VersioningOptions> = async function versioningPlugin(
  app,
  options = {},
) {
  const supportedVersions = options.supportedVersions ?? DEFAULT_SUPPORTED_VERSIONS;
  const excludedPaths = options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS;

  // Request hook to reject unversioned or invalid-version requests
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Extract pathname without query string
    const url = request.raw.url ?? request.url;
    const pathname = url.split("?")[0] ?? "/";

    if (isPathExcluded(pathname, excludedPaths)) {
      return;
    }

    // Match leading /v<digit>
    const match = /^\/([^/]+)/.exec(pathname);
    const prefix = match ? match[1] : undefined;

    if (!prefix || !/^v\d+$/i.test(prefix)) {
      sendApiError(
        reply,
        "VALIDATION_ERROR",
        `API version prefix missing. Requests must be prefixed with a valid API version (e.g. /${supportedVersions[0] ?? "v1"}/...).`,
      );
      return reply;
    }

    if (!supportedVersions.includes(prefix.toLowerCase())) {
      sendApiError(
        reply,
        "NOT_FOUND",
        `API version '${prefix}' is not supported. Supported versions: ${supportedVersions.join(", ")}.`,
      );
      return reply;
    }
  });

  // onSend hook to emit Deprecation and Sunset headers if route is flagged
  app.addHook("onSend", async (request, reply, payload) => {
    const config = request.routeOptions?.config;
    if (config?.deprecated) {
      reply.header("Deprecation", "true");
      if (config.sunset !== undefined) {
        reply.header("Sunset", toHttpDate(config.sunset));
      }
    }
    return payload;
  });
};

// Make plugin global so it breaks Fastify encapsulation and protects all routes across the app
(versioningPlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;

export const versioning = versioningPlugin;
