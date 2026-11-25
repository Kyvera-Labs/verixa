import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Builds the compose prefix once. Every backup/restore command goes through
 * the same file list so a drill cannot accidentally target the dev stack.
 *
 * @param {{ composeFiles: string[], envFile?: string }} options
 * @returns {string[]}
 */
export function composeArguments(options) {
  const args = ["compose"];
  if (options.envFile) args.push("--env-file", options.envFile);
  for (const file of options.composeFiles) args.push("--file", file);
  return args;
}

/**
 * @typedef {object} CommandStep
 * @property {string} name
 * @property {string[]} argv
 * @property {string} [outputFile]
 * @property {string} [stdinFile]
 */

/**
 * Default runner used by the CLIs. Streams a command's stdout to a file when
 * the step is a dump, or into stdin when the step is a restore.
 *
 * @param {string[]} argv
 * @param {{ outputFile?: string, stdinFile?: string }} [options]
 * @returns {Promise<string>}
 */
export async function runDocker(argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`docker ${argv.join(" ")} exited with ${code}: ${stderr.trim()}`));
        return;
      }
      const output = Buffer.concat(chunks);
      if (options.outputFile && (output.length > 0 || !existsSync(options.outputFile))) {
        mkdirSync(dirname(options.outputFile), { recursive: true });
        writeFileSync(options.outputFile, output);
      }
      resolve(output.toString("utf8"));
    });
    if (options.stdinFile) {
      createReadStream(options.stdinFile).pipe(child.stdin);
    } else {
      child.stdin.end();
    }
  });
}
