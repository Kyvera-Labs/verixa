import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_TARGET = "/root/.local/share/pnpm/store";

/**
 * @typedef {object} CachePlan
 * @property {string[]} manifestPaths
 * @property {string[]} sourcePaths
 * @property {boolean} usesParentsCopy
 * @property {boolean} copiesPackageSourcesIntoDeps
 * @property {boolean} installUsesCacheMount
 * @property {boolean} deployUsesCacheMount
 * @property {string[]} cacheFrom
 * @property {string[]} cacheTo
 * @property {string[]} errors
 */

function stageBoundaries(dockerfileText) {
  const lines = dockerfileText.split(/\r?\n/);
  const stages = [];
  let current = null;

  lines.forEach((line, index) => {
    const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (match) {
      current = { image: match[1], name: match[2] ?? "", start: index, end: lines.length };
      if (stages.length > 0) stages[stages.length - 1].end = index;
      stages.push(current);
    }
  });

  return { lines, stages };
}

/** Joins Docker's backslash continuations so flags on a `RUN` line stay attached to its command. */
function logicalCommands(lines) {
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    const start = index;
    let text = lines[index];
    while (/\\\s*$/.test(text) && index + 1 < lines.length) {
      text = `${text.replace(/\\\s*$/, " ")}${lines[index + 1].trim()}`;
      index += 1;
    }
    commands.push({ text, start });
  }
  return commands;
}

/** Reads the dependency layer's declared inputs and cache mounts from a Dockerfile. */
function readDockerfilePlan(dockerfileText) {
  const { lines, stages } = stageBoundaries(dockerfileText);
  const commands = logicalCommands(lines);
  const deps = stages.find((stage) => stage.name === "deps");
  const depsCommands = deps
    ? commands.filter((command) => command.start > deps.start && command.start < deps.end)
    : [];
  const manifestPaths = [];

  let installIndex = -1;
  for (const [offset, command] of depsCommands.entries()) {
    const copy = /^\s*COPY\s+(.*?)\s+(\S+)\s*$/.exec(command.text);
    if (copy) {
      const usesParents = /\s--parents(?:\s|$)/.test(command.text);
      const sources = copy[1]
        .split(/\s+/)
        .filter((token) => token.length > 0 && !token.startsWith("--"));
      for (const source of sources) {
        if (usesParents) manifestPaths.push(source);
        if (!usesParents && (source === "packages" || source.includes("/src"))) {
          // A whole-source COPY before `pnpm install` is the regression this
          // issue fixes: it invalidates the install layer on every code edit.
          if (installIndex === -1) manifestPaths.push(`SOURCE:${source}`);
        }
      }
    }
    if (/^\s*RUN\s+[^\n]*pnpm\s+install\b/.test(command.text) && installIndex === -1) {
      installIndex = offset;
    }
  }

  const mountTargets = (line) =>
    [...line.matchAll(/--mount=type=cache,[^\s\\]*/g)]
      .map((match) => match[0])
      .flatMap((flag) => [...flag.matchAll(/target=([^,\s]+)/g)].map((target) => target[1]));
  const usesStore = (command) =>
    mountTargets(command.text).includes(STORE_TARGET) && command.text.includes("--store-dir");

  return {
    manifestPaths: manifestPaths.filter((path) => !path.startsWith("SOURCE:")),
    sourcePaths: manifestPaths
      .filter((path) => path.startsWith("SOURCE:"))
      .map((path) => path.slice("SOURCE:".length)),
    usesParentsCopy: depsCommands.some((command) => /^\s*COPY\s+--parents\s+/.test(command.text)),
    copiesPackageSourcesIntoDeps: manifestPaths.some((path) => path.startsWith("SOURCE:")),
    installUsesCacheMount: depsCommands.some(
      (command, offset) => offset === installIndex && usesStore(command),
    ),
    deployUsesCacheMount: commands.some(
      (command) => /pnpm\s+.*deploy\s+\/out/.test(command.text) && usesStore(command),
    ),
    installLineIndex: installIndex,
  };
}

function matchPathPattern(pattern, path) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(path);
}

/**
 * Fingerprints only the inputs the dependency layer actually copies. The
 * Dockerfile supplies the paths, so a cache regression in the Dockerfile
 * changes the fingerprint even when no manifest changed.
 *
 * @param {Readonly<Record<string, string>>} files
 * @param {string} dockerfileText
 * @returns {string}
 */
export function dependencyFingerprint(files, dockerfileText) {
  const plan = readDockerfilePlan(dockerfileText);
  const paths = Object.keys(files)
    .filter(
      (path) =>
        plan.sourcePaths.some((source) => path === source || path.startsWith(`${source}/`)) ||
        plan.manifestPaths.some((pattern) => matchPathPattern(pattern, path)),
    )
    .sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(`${path}\0${files[path]}\0`);
  }
  return hash.digest("hex");
}

/** Reads registry cache configuration from the workflow that builds the image. */
function readWorkflowCachePlan(workflowText) {
  const values = (key) =>
    [...workflowText.matchAll(new RegExp(`^\\s*${key}:\\s*(.+)$`, "gm"))].map((match) =>
      match[1].trim(),
    );
  return { cacheFrom: values("cache-from"), cacheTo: values("cache-to") };
}

/**
 * @param {string} dockerfileText
 * @param {string} workflowText
 * @returns {CachePlan}
 */
export function analyzeCacheConfiguration(dockerfileText, workflowText) {
  const dockerfile = readDockerfilePlan(dockerfileText);
  const workflow = readWorkflowCachePlan(workflowText);
  const hasGhaCache =
    workflow.cacheFrom.some((value) => value.includes("type=gha")) &&
    workflow.cacheTo.some((value) => value.includes("type=gha") && value.includes("mode=max"));
  const errors = [];

  const syntaxVersion = /^#\s*syntax=docker\/dockerfile:1\.(\d+)/m.exec(dockerfileText);
  if (!syntaxVersion || Number(syntaxVersion[1]) < 20) {
    errors.push("Dockerfile needs the dockerfile:1.20+ frontend for --parents and cache mounts");
  }
  if (!dockerfile.usesParentsCopy) {
    errors.push("deps stage must copy workspace manifests with COPY --parents");
  }
  if (dockerfile.copiesPackageSourcesIntoDeps) {
    errors.push("deps stage must not COPY package sources before pnpm install");
  }
  if (!dockerfile.installUsesCacheMount) {
    errors.push("pnpm install must use the shared pnpm store cache mount");
  }
  if (!dockerfile.deployUsesCacheMount) {
    errors.push("pnpm deploy must use the same shared pnpm store cache mount");
  }
  if (!hasGhaCache) {
    errors.push("publish workflow must import and export BuildKit GHA cache in max mode");
  }

  return {
    manifestPaths: dockerfile.manifestPaths,
    sourcePaths: dockerfile.sourcePaths,
    usesParentsCopy: dockerfile.usesParentsCopy,
    copiesPackageSourcesIntoDeps: dockerfile.copiesPackageSourcesIntoDeps,
    installUsesCacheMount: dockerfile.installUsesCacheMount,
    deployUsesCacheMount: dockerfile.deployUsesCacheMount,
    cacheFrom: workflow.cacheFrom,
    cacheTo: workflow.cacheTo,
    errors,
  };
}

/**
 * @param {{ coldSeconds: number, warmSeconds: number, sourceSeconds: number }} timings
 * @returns {string[]} human-readable measurements
 */
export function assertBuildTimings(timings) {
  const { coldSeconds, warmSeconds, sourceSeconds } = timings;
  for (const [name, value] of Object.entries(timings)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a non-negative number of seconds`);
    }
  }
  if (coldSeconds <= 0) {
    throw new Error("coldSeconds must be greater than zero");
  }
  const limit = coldSeconds * 0.75;
  const messages = [`cold ${coldSeconds}s, warm ${warmSeconds}s, source-only ${sourceSeconds}s`];
  if (warmSeconds > limit) {
    throw new Error(`warm build ${warmSeconds}s exceeded 75% of cold build ${coldSeconds}s`);
  }
  if (sourceSeconds > limit) {
    throw new Error(
      `source-only build ${sourceSeconds}s exceeded 75% of cold build ${coldSeconds}s`,
    );
  }
  return messages;
}

/**
 * Resolves whether a build step was served from cache or executed, from
 * BuildKit's plain-progress log.
 *
 * @param {string} log
 * @param {string} stepText
 * @returns {"CACHED" | "REBUILT"}
 */
export function stepStatus(log, stepText) {
  const commands = new Map();
  for (const line of log.split(/\r?\n/)) {
    const step = /^#(\d+)\s+\[[^\]]+\]\s+(.+)$/.exec(line);
    if (step && step[1] && step[2]) commands.set(step[1], step[2]);
  }
  let status = "REBUILT";
  for (const line of log.split(/\r?\n/)) {
    const result = /^#(\d+)\s+(CACHED|ERROR|DONE in .+)$/.exec(line);
    if (result && result[1] && result[2]) {
      if (commands.get(result[1])?.includes(stepText)) {
        status = result[2] === "CACHED" ? "CACHED" : "REBUILT";
      }
    }
  }
  if (![...commands.values()].some((command) => command.includes(stepText))) {
    throw new Error(`build log has no step containing "${stepText}"`);
  }
  return status;
}

function requireValue(flag, argv) {
  const index = argv.indexOf(flag);
  if (index === -1 || !argv[index + 1]) throw new Error(`missing ${flag}`);
  return argv[index + 1];
}

function main() {
  const [, , command, ...argv] = process.argv;

  if (command === "assert-log") {
    const log = readFileSync(requireValue("--log", argv), "utf8");
    const expected = requireValue("--expect", argv);
    const step = argv.includes("--step") ? requireValue("--step", argv) : "pnpm install";
    const actual = stepStatus(log, step);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`expected ${step} to be ${expected}, got ${actual}`);
    }
    console.log(`${step}: ${actual}`);
    return;
  }

  if (command === "assert-timings") {
    const timings = {
      coldSeconds: Number(requireValue("--cold", argv)),
      warmSeconds: Number(requireValue("--warm", argv)),
      sourceSeconds: Number(requireValue("--source", argv)),
    };
    console.log(assertBuildTimings(timings).join("\n"));
    return;
  }

  const repo = argv.includes("--repo") ? requireValue("--repo", argv) : process.cwd();
  const dockerfileText = readFileSync(join(repo, "apps/api/Dockerfile"), "utf8");
  const workflowText = readFileSync(join(repo, ".github/workflows/docker-publish.yml"), "utf8");
  const plan = analyzeCacheConfiguration(dockerfileText, workflowText);
  console.log(JSON.stringify(plan, null, 2));
  if (plan.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`docker-cache-check: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
