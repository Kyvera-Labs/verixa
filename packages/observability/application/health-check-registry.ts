export type DependencyStatus = "up" | "down";

export interface DependencyCheckResult {
  readonly status: DependencyStatus;
  readonly latencyMs: number;
  readonly message?: string;
  readonly error?: string;
}

export interface HealthCheckResult {
  readonly status: "healthy" | "unhealthy";
  readonly timestamp: string;
  readonly durationMs: number;
  readonly dependencies: Readonly<Record<string, DependencyCheckResult>>;
}

export type DependencyCheckFn = (signal?: AbortSignal) => Promise<void>;

export interface DependencyCheckRegistration {
  readonly name: string;
  readonly check: DependencyCheckFn;
  readonly timeoutMs?: number;
  readonly required?: boolean;
}

export interface HealthCheckRegistryOptions {
  readonly defaultTimeoutMs?: number;
}

/**
 * Registry orchestrating liveness/readiness dependency health probes with bounded timeouts.
 *
 * Designed to prevent "probe failure storms": if a dependency hangs, the probe will terminate
 * deterministically within its configured bounded timeout rather than exhausting container
 * probe budgets or blocking orchestrator checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, DependencyCheckRegistration>();
  private readonly defaultTimeoutMs: number;

  constructor(options: HealthCheckRegistryOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 2000;
  }

  /**
   * Registers a named dependency health check probe.
   */
  register(registration: DependencyCheckRegistration): void {
    this.checks.set(registration.name, registration);
  }

  /**
   * Unregisters a dependency health check by name.
   */
  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  /**
   * Returns all currently registered dependency names.
   */
  getRegisteredNames(): string[] {
    return Array.from(this.checks.keys());
  }

  /**
   * Executes all registered dependency checks in parallel with bounded timeouts.
   * Returns a HealthCheckResult containing per-dependency latencies and status.
   */
  async check(timeoutMsOverride?: number): Promise<HealthCheckResult> {
    const overallStart = performance.now();
    const timestamp = new Date().toISOString();

    const registrations = Array.from(this.checks.values());
    const dependencyResults: Record<string, DependencyCheckResult> = {};

    let hasUnhealthyRequiredDependency = false;

    await Promise.all(
      registrations.map(async (reg) => {
        const timeoutMs = reg.timeoutMs ?? timeoutMsOverride ?? this.defaultTimeoutMs;
        const required = reg.required !== false;

        const checkStart = performance.now();
        const controller = new AbortController();

        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort();
            reject(
              new Error(`Dependency health check for '${reg.name}' timed out after ${timeoutMs}ms`),
            );
          }, timeoutMs);
        });

        try {
          await Promise.race([reg.check(controller.signal), timeoutPromise]);
          const latencyMs = Math.round(performance.now() - checkStart);
          dependencyResults[reg.name] = {
            status: "up",
            latencyMs,
          };
        } catch (err: unknown) {
          const latencyMs = Math.round(performance.now() - checkStart);
          const errorMessage = err instanceof Error ? err.message : String(err);

          dependencyResults[reg.name] = {
            status: "down",
            latencyMs,
            error: errorMessage,
          };

          if (required) {
            hasUnhealthyRequiredDependency = true;
          }
        } finally {
          if (timeoutHandle !== undefined) {
            clearTimeout(timeoutHandle);
          }
        }
      }),
    );

    const overallDuration = Math.round(performance.now() - overallStart);

    return {
      status: hasUnhealthyRequiredDependency ? "unhealthy" : "healthy",
      timestamp,
      durationMs: overallDuration,
      dependencies: dependencyResults,
    };
  }
}

/**
 * Creates a standard health check registration for a Prisma / PostgreSQL database connection.
 */
export function createPostgresHealthCheck(
  prisma: { $queryRaw: (template: TemplateStringsArray) => Promise<unknown> },
  options: { timeoutMs?: number; required?: boolean } = {},
): DependencyCheckRegistration {
  return {
    name: "postgres",
    timeoutMs: options.timeoutMs ?? 2000,
    required: options.required ?? true,
    check: async () => {
      // Tagged template safe query
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}

/**
 * Creates a standard health check registration for a Redis instance.
 */
export function createRedisHealthCheck(
  redis: { ping: () => Promise<string> },
  options: { timeoutMs?: number; required?: boolean } = {},
): DependencyCheckRegistration {
  return {
    name: "redis",
    timeoutMs: options.timeoutMs ?? 2000,
    required: options.required ?? true,
    check: async () => {
      const response = await redis.ping();
      if (response !== "PONG") {
        throw new Error(`Unexpected Redis ping response: ${response}`);
      }
    },
  };
}
