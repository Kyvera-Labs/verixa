import { ApiKey, type ApiKeyStatus } from "@verixa/identity";
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

export interface ServicePrincipal {
  readonly type: "service_principal";
  readonly id: string;
  readonly name: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
  readonly permissions: ReadonlySet<string>;
}

declare module "fastify" {
  interface FastifyRequest {
    servicePrincipal?: ServicePrincipal | undefined;
    principal?: {
      userId?: string;
      orgId?: string | null;
      type?: "user" | "service_principal";
      permissions?: Set<string>;
    } | undefined;
  }
}

export interface ApiKeyLookupPort {
  findByKeyHash(keyHash: string): Promise<ApiKey | undefined>;
}

export interface ApiKeyAuthPluginOptions {
  readonly apiKeyRepository: ApiKeyLookupPort;
  /**
   * Paths excluded from API key requirement (e.g. public health / docs).
   */
  readonly excludedPaths?: readonly (string | RegExp)[];
  /**
   * If true, requests with no Authorization header continue without failing.
   * If an API key header is provided, it must be valid.
   */
  readonly optional?: boolean;
}

const DEFAULT_EXCLUDED_PATHS: readonly (string | RegExp)[] = [
  "/health",
  "/docs",
  /^\/docs(\/.*)?$/,
  "/favicon.ico",
  "/auth/login",
  "/auth/register",
];

function isPathExcluded(urlPath: string, exclusions: readonly (string | RegExp)[]): boolean {
  for (const exclusion of exclusions) {
    if (typeof exclusion === "string") {
      if (urlPath === exclusion || urlPath.startsWith(`${exclusion}/`)) return true;
    } else if (exclusion.test(urlPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts raw API key from `Authorization: ApiKey <key>` or `X-API-Key: <key>`.
 */
export function extractApiKey(request: FastifyRequest): string | undefined {
  const authHeader = request.headers["authorization"];
  if (typeof authHeader === "string") {
    const parts = authHeader.trim().split(/\s+/);
    if (parts.length === 2 && (parts[0]?.toLowerCase() === "apikey" || parts[0]?.toLowerCase() === "bearer")) {
      if (parts[1]?.startsWith("vx_")) {
        return parts[1];
      }
      if (parts[0]?.toLowerCase() === "apikey") {
        return parts[1];
      }
    }
  }

  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim().length > 0) {
    return xApiKey.trim();
  }

  return undefined;
}

/**
 * Fastify authentication strategy accepting `Authorization: ApiKey <key>`
 * resolving to a ServicePrincipal.
 */
const apiKeyAuthPlugin: FastifyPluginAsync<ApiKeyAuthPluginOptions> = async function apiKeyAuth(
  app,
  options,
) {
  const excludedPaths = options.excludedPaths ?? DEFAULT_EXCLUDED_PATHS;

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = (request.raw.url ?? request.url).split("?")[0] ?? "/";
    if (isPathExcluded(pathname, excludedPaths)) {
      return;
    }

    const rawKey = extractApiKey(request);
    if (!rawKey) {
      if (options.optional) {
        return;
      }
      sendApiError(reply, "AUTHENTICATION_FAILED", "Authentication required. Provide an API key or bearer token.");
      return reply;
    }

    const keyHash = ApiKey.hashKey(rawKey);
    const key = await options.apiKeyRepository.findByKeyHash(keyHash);

    if (!key) {
      sendApiError(reply, "AUTHENTICATION_FAILED", "Invalid API key.");
      return reply;
    }

    if (!key.matchesKey(rawKey)) {
      sendApiError(reply, "AUTHENTICATION_FAILED", "Invalid API key.");
      return reply;
    }

    if (!key.isActive()) {
      const message = key.status === "revoked" ? "API key has been revoked." : "API key has expired.";
      sendApiError(reply, "AUTHENTICATION_FAILED", message);
      return reply;
    }

    const permissionsSet = new Set<string>(key.scopes);

    const principal: ServicePrincipal = {
      type: "service_principal",
      id: key.id,
      name: key.name,
      organizationId: key.organizationId,
      scopes: key.scopes,
      permissions: permissionsSet,
    };

    request.servicePrincipal = principal;
    request.principal = {
      userId: key.id as any,
      orgId: key.organizationId as any,
      type: "service_principal",
      permissions: permissionsSet,
    };
  });
};

(apiKeyAuthPlugin as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;

export const apiKeyAuth = apiKeyAuthPlugin;
