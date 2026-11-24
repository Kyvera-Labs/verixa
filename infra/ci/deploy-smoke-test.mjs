#!/usr/bin/env node

/**
 * Post-deploy smoke test for Verixa staging and production deployments.
 *
 * Verifies two invariants before a deployment is marked successful:
 *   1. Readiness: GET <baseUrl>/health returns HTTP 200 within the retry budget.
 *   2. Version:   when --expected-version is supplied, GET <baseUrl>/version
 *                 returns HTTP 200 and includes the expected tag or commit SHA.
 *
 * Checking /version alongside /health prevents a common false positive where a
 * failed container replacement leaves the previous healthy container serving
 * traffic, causing a /health-only check to report a broken deploy as green.
 */

import { pathToFileURL } from "node:url";

const DEFAULT_RETRIES = 15;
const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Parse CLI arguments into validated smoke-test options.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  let url = process.env.DEPLOY_TARGET_URL ?? "";
  let expectedVersion = process.env.DEPLOY_EXPECTED_VERSION ?? "";
  let retries = DEFAULT_RETRIES;
  let intervalMs = DEFAULT_INTERVAL_MS;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--url" && next !== undefined) {
      url = next;
      i += 1;
    } else if (arg === "--expected-version" && next !== undefined) {
      expectedVersion = next;
      i += 1;
    } else if (arg === "--retries" && next !== undefined) {
      retries = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--interval-ms" && next !== undefined) {
      intervalMs = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--timeout-ms" && next !== undefined) {
      timeoutMs = Number.parseInt(next, 10);
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!url) {
    throw new Error("Missing required --url argument (or DEPLOY_TARGET_URL env var).");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
  }

  if (!Number.isInteger(retries) || retries < 1) {
    throw new Error(`--retries must be a positive integer, got: ${String(retries)}`);
  }

  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error(`--interval-ms must be a non-negative integer, got: ${String(intervalMs)}`);
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`--timeout-ms must be a positive integer, got: ${String(timeoutMs)}`);
  }

  return {
    url: parsedUrl.toString().replace(/\/+$/, ""),
    expectedVersion: expectedVersion.trim(),
    retries,
    intervalMs,
    timeoutMs,
  };
}

/**
 * Fetch a single endpoint with an explicit AbortController timeout.
 * @param {string} targetUrl
 * @param {number} timeoutMs
 */
async function fetchWithTimeout(targetUrl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json, text/plain;q=0.9" },
    });
    const body = await response.text();
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep for the specified number of milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Execute the post-deploy smoke test against a running Verixa API instance.
 * @param {{ url: string, expectedVersion?: string, retries?: number, intervalMs?: number, timeoutMs?: number }} options
 */
export async function runSmokeTest(options) {
  const baseUrl = options.url.replace(/\/+$/, "");
  const expectedVersion = (options.expectedVersion ?? "").trim();
  const retries = options.retries ?? DEFAULT_RETRIES;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const healthUrl = `${baseUrl}/health`;
  const versionUrl = `${baseUrl}/version`;

  let lastError = "unknown error";
  let attempts = 0;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    attempts = attempt;
    try {
      const health = await fetchWithTimeout(healthUrl, timeoutMs);
      if (health.status === 200) {
        if (!expectedVersion) {
          return {
            ok: true,
            attempts,
            healthStatus: health.status,
            versionBody: null,
          };
        }

        const version = await fetchWithTimeout(versionUrl, timeoutMs);
        if (version.status !== 200) {
          lastError = `GET ${versionUrl} returned HTTP ${String(version.status)}`;
        } else if (!version.body.includes(expectedVersion)) {
          lastError = `Version mismatch: expected "${expectedVersion}" in response "${version.body.trim()}"`;
        } else {
          return {
            ok: true,
            attempts,
            healthStatus: health.status,
            versionBody: version.body.trim(),
          };
        }
      } else {
        lastError = `GET ${healthUrl} returned HTTP ${String(health.status)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < retries && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }

  return {
    ok: false,
    attempts,
    error: `Smoke test failed after ${String(attempts)} attempt(s): ${lastError}`,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 2;
    return;
  }

  const result = await runSmokeTest(options);
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }

  const versionNote = result.versionBody ? ` (version: ${result.versionBody})` : "";
  console.log(
    `Smoke test passed for ${options.url} after ${String(result.attempts)} attempt(s)${versionNote}.`,
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  await main();
}
