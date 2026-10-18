import { createHash } from "node:crypto";

import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import type { Redis } from "ioredis";

import { sendApiError } from "../http/error-response.js";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours

export interface IdempotencyRecord {
  requestHash: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  createdAt: number;
}

export interface IdempotencyPluginOptions {
  redisClient?: Redis;
  ttlSeconds?: number;
}

/**
 * Storage adapter for idempotency records.
 * Supports Redis when configured, and falls back to an in-memory Map for testing or standalone execution.
 */
export class IdempotencyStore {
  private memoryStore = new Map<string, { record: IdempotencyRecord; expiresAt: number }>();

  constructor(
    private readonly redis?: Redis,
    private readonly ttlSeconds: number = DEFAULT_IDEMPOTENCY_TTL_SECONDS,
  ) {}

  private getRedisKey(key: string): string {
    return `idempotency:${key}`;
  }

  async get(key: string): Promise<IdempotencyRecord | null> {
    if (this.redis) {
      const data = await this.redis.get(this.getRedisKey(key));
      if (!data) return null;
      try {
        return JSON.parse(data) as IdempotencyRecord;
      } catch {
        return null;
      }
    }

    const entry = this.memoryStore.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }

    return entry.record;
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    if (this.redis) {
      await this.redis.set(this.getRedisKey(key), JSON.stringify(record), "EX", this.ttlSeconds);
      return;
    }

    this.memoryStore.set(key, {
      record,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    });
  }

  async clear(): Promise<void> {
    if (this.redis) {
      const keys = await this.redis.keys("idempotency:*");
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
      return;
    }
    this.memoryStore.clear();
  }
}

/**
 * Creates a deterministic SHA-256 fingerprint for a request URL, method, and payload.
 */
export function hashRequest(method: string, url: string, body: unknown): string {
  const hash = createHash("sha256");
  hash.update(`${method.toUpperCase()}:${url}:`);
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      hash.update(body);
    } else {
      hash.update(JSON.stringify(body));
    }
  }
  return hash.digest("hex");
}

declare module "fastify" {
  interface FastifyRequest {
    idempotencyKey?: string;
    idempotencyRequestHash?: string;
  }
}

/**
 * Registers idempotency key handling across unsafe write operations (primarily POST).
 */
export function registerIdempotency<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  options: IdempotencyPluginOptions = {},
): void {
  const store = new IdempotencyStore(options.redisClient, options.ttlSeconds);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    // Idempotency applies to state-mutating requests (POST, PATCH)
    if (request.method !== "POST" && request.method !== "PATCH") {
      return;
    }

    const rawKey = request.headers[IDEMPOTENCY_HEADER];
    if (!rawKey || typeof rawKey !== "string" || rawKey.trim().length === 0) {
      return;
    }

    const idempotencyKey = rawKey.trim();
    request.idempotencyKey = idempotencyKey;

    const currentHash = hashRequest(request.method, request.url, request.body);
    request.idempotencyRequestHash = currentHash;

    const existingRecord = await store.get(idempotencyKey);
    if (existingRecord) {
      // If the request hash doesn't match the original request, reject as conflict
      if (existingRecord.requestHash !== currentHash) {
        sendApiError(
          reply,
          "CONFLICT",
          "Idempotency key reused with conflicting request payload or URL.",
        );
        return reply;
      }

      // Replay original response
      reply.header("X-Cache-Lookup", "HIT");
      reply.header("Idempotency-Replayed", "true");
      reply.status(existingRecord.statusCode);

      // Re-send original headers if safe
      if (existingRecord.headers["content-type"]) {
        reply.header("content-type", existingRecord.headers["content-type"]);
      }

      return reply.send(existingRecord.body);
    }
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const key = request.idempotencyKey;
    const reqHash = request.idempotencyRequestHash;

    if (!key || !reqHash || reply.statusCode >= 500) {
      return payload;
    }

    // Do not re-cache replayed responses
    if (reply.getHeader("Idempotency-Replayed") === "true") {
      return payload;
    }

    // Save successful / client response in idempotency store
    const serializedPayload =
      typeof payload === "string"
        ? payload
        : Buffer.isBuffer(payload)
          ? payload.toString("utf-8")
          : JSON.stringify(payload);

    const record: IdempotencyRecord = {
      requestHash: reqHash,
      statusCode: reply.statusCode,
      headers: {
        "content-type": reply.getHeader("content-type") as string | undefined,
      },
      body: serializedPayload,
      createdAt: Date.now(),
    };

    await store.set(key, record);
    return payload;
  });
}

export default registerIdempotency;
