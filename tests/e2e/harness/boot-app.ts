import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

export interface BootedApp {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate an ephemeral port for the API process");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function processExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** Starts the compiled API in a separate Node process and waits for HTTP health. */
export async function bootApp(options: {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly version?: string;
}): Promise<BootedApp> {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let output = "";
  // pnpm injects @verixa/stellar-anchor as a copy that can lack ignored dist
  // output in a clean checkout. The same resolver alias used by integration
  // tests maps that one dependency to its freshly-built workspace output.
  const loader = new URL("./workspace-loader.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    ["--experimental-loader", loader, "apps/api/dist/server.js"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: String(port),
        DATABASE_URL: options.databaseUrl,
        REDIS_URL: options.redisUrl,
        SESSION_ACCESS_TOKEN_SECRET: "e2e-only-secret-value-with-more-than-32-chars",
        VERIXA_BUILD_VERSION: options.version ?? "e2e-smoke",
        LOG_LEVEL: "error",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited with code ${child.exitCode} before health check.\n${output}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      const body = (await response.json()) as { readonly status?: unknown };
      if (response.ok && body.status === "ok") {
        return {
          baseUrl,
          stop: async () => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await Promise.race([processExit(child), delay(10_000)]);
            if (child.exitCode === null) child.kill("SIGKILL");
          },
        };
      }
    } catch {
      // The listener may not be bound yet; its child output is attached to a
      // timeout error so startup failures retain their useful diagnostics.
    }
    await delay(250);
  }
  child.kill("SIGKILL");
  throw new Error(`API did not report healthy within 90 seconds.\n${output}`);
}
