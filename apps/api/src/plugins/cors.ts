import cors, { type FastifyCorsOptions } from "@fastify/cors";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";

export interface CorsConfig {
  readonly allowedOrigins: readonly string[];
  readonly allowCredentials?: boolean;
}

export const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
];

export const DEFAULT_PROD_ORIGINS = ["https://app.verixa.io", "https://api.verixa.io"];

export function getCorsOptions(config?: Partial<CorsConfig>): FastifyCorsOptions {
  const nodeEnv = process.env["NODE_ENV"] ?? "development";
  const defaultOrigins = nodeEnv === "production" ? DEFAULT_PROD_ORIGINS : DEFAULT_DEV_ORIGINS;
  const allowedOrigins = config?.allowedOrigins ?? defaultOrigins;
  const allowCredentials = config?.allowCredentials ?? true;

  return {
    origin: (origin, cb) => {
      // Allow requests with no origin (like mobile apps, curl, or same-origin server requests)
      if (!origin) {
        cb(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        cb(null, true);
        return;
      }

      // Explicitly reject non-allow-listed origins
      cb(new Error("Not allowed by CORS"), false);
    },
    credentials: allowCredentials,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Origin",
      "X-Requested-With",
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Request-Id",
      "X-Api-Key",
      "Idempotency-Key",
    ],
    exposedHeaders: [
      "X-Request-Id",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      "Retry-After",
    ],
    maxAge: 86400,
  };
}

export function registerCors<TLogger extends FastifyBaseLogger = FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    TLogger
  >,
  config?: Partial<CorsConfig>,
): void {
  app.register(cors, getCorsOptions(config));
}

export default registerCors;
