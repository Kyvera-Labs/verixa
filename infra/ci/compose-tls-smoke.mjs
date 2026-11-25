#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPOSE_FILE = "infra/docker/docker-compose.tls-smoke.yml";

/**
 * @param {{ certDirectory: string, domain?: string, days?: number }} options
 * @returns {Array<{ name: string, argv: string[] }>}
 */
export function certificateCommands(options) {
  const domain = options.domain ?? "localhost";
  return [
    {
      name: "generate-self-signed-certificate",
      argv: [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(options.certDirectory, "privkey.pem"),
        "-out",
        join(options.certDirectory, "fullchain.pem"),
        "-days",
        String(options.days ?? 1),
        "-subj",
        `/CN=${domain}`,
      ],
    },
  ];
}

/**
 * Builds the exact commands CI runs against the smoke stack. Keeping this as
 * data lets the tests prove the ordering and the assertions, not just the
 * presence of a workflow step.
 *
 * @param {{ composeFile?: string, certDirectory: string, domain?: string, httpPort: number, httpsPort: number }} options
 * @returns {Array<{ name: string, argv: string[] }>}
 */
export function tlsSmokeCommands(options) {
  const composeFile = options.composeFile ?? COMPOSE_FILE;
  const domain = options.domain ?? "localhost";
  const certificate = join(options.certDirectory, "fullchain.pem");
  const compose = ["docker", "compose", "--file", composeFile];
  const env = {
    ...process.env,
    PORT_HTTP: String(options.httpPort),
    PORT_HTTPS: String(options.httpsPort),
  };

  return [
    ...certificateCommands({ certDirectory: options.certDirectory, domain }),
    {
      name: "start-proxy-and-stub-api",
      argv: [...compose, "up", "-d", "--wait"],
      env,
    },
    {
      name: "http-redirect",
      argv: [
        "curl",
        "--silent",
        "--show-error",
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code} %{redirect_url}",
        `http://${domain}:${options.httpPort}/health`,
      ],
    },
    {
      name: "tls-handshake-and-proxy-forwarding",
      argv: [
        "curl",
        "--silent",
        "--show-error",
        "--fail",
        "--cacert",
        certificate,
        `https://${domain}:${options.httpsPort}/health`,
      ],
    },
    {
      name: "stop-smoke-stack",
      argv: [...compose, "down", "--volumes"],
      env,
    },
  ];
}

/**
 * @param {string} httpOutput
 * @param {string} httpsBody
 */
export function assertSmokeResults(httpOutput, httpsBody) {
  const match = /^(\d{3})\s+(\S+)/.exec(httpOutput.trim());
  if (!match) throw new Error(`unexpected HTTP probe output: ${httpOutput}`);
  const status = Number(match[1]);
  const redirect = match[2];
  if (![301, 302, 308].includes(status)) {
    throw new Error(`expected an HTTP to HTTPS redirect, got ${status}`);
  }
  if (!redirect?.startsWith("https://")) {
    throw new Error(`redirect target is not HTTPS: ${redirect}`);
  }
  if (httpsBody.trim() !== "ok") {
    throw new Error(`proxy did not forward /health to api: ${httpsBody}`);
  }
  return { status, redirect };
}

/**
 * @param {Parameters<typeof tlsSmokeCommands>[0]} options
 * @param {(argv: string[], env?: NodeJS.ProcessEnv) => Promise<string>} runner
 */
export async function runTlsSmoke(options, runner) {
  mkdirSync(options.certDirectory, { recursive: true });
  const commands = tlsSmokeCommands(options);
  const outputs = {};
  let cleanupError;
  try {
    for (const command of commands.slice(0, -1)) {
      outputs[command.name] = await runner(command.argv, command.env);
    }
    assertSmokeResults(
      outputs["http-redirect"] ?? "",
      outputs["tls-handshake-and-proxy-forwarding"] ?? "",
    );
  } finally {
    try {
      await runner(commands[commands.length - 1].argv, commands[commands.length - 1].env);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError) throw cleanupError;
  return outputs;
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
function runCommand(argv, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${argv.join(" ")} exited with ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("compose-tls-smoke.mjs")) {
  const httpPort = Number(process.env.PORT_HTTP ?? 18080);
  const httpsPort = Number(process.env.PORT_HTTPS ?? 18443);
  try {
    await runTlsSmoke({ certDirectory: "infra/nginx/certs", httpPort, httpsPort }, runCommand);
    console.log("TLS smoke passed: HTTP redirects, HTTPS handshakes, /health proxied");
  } catch (error) {
    console.error(`compose-tls-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
