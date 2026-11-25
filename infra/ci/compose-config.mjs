import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

class ResetValue {
  /** @param {unknown} value */
  constructor(value) {
    this.value = value;
  }
}

const resetTag = {
  tag: "!reset",
  collection: "seq",
  resolve: (sequence) =>
    new ResetValue(
      sequence?.items?.map((item) =>
        typeof item?.toJS === "function" ? item.toJS() : item?.value,
      ) ?? [],
    ),
};

/**
 * Parses the two compose files with `!reset` preserved, so tests can simulate
 * the same merge `docker compose -f base -f overlay config` performs.
 *
 * @param {string} baseText
 * @param {string} overlayText
 */
export function parseComposeOverlay(baseText, overlayText) {
  return {
    base: parseYaml(baseText, { customTags: [resetTag] }),
    overlay: parseYaml(overlayText, { customTags: [resetTag] }),
  };
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof ResetValue)
  );
}

/**
 * @param {unknown} item
 * @returns {string}
 */
function composeItemKey(item, field = "") {
  if (typeof item === "string") {
    const parts = item.split(":");
    if (field === "volumes" && parts.length > 1) {
      const last = parts[parts.length - 1];
      const hasMode = last === "ro" || last === "rw";
      return hasMode ? parts[parts.length - 2] : last;
    }
    return parts.length > 1 ? parts[parts.length - 1] : item;
  }
  if (isPlainObject(item)) {
    return String(item.target ?? item.source ?? JSON.stringify(item));
  }
  return JSON.stringify(item);
}

/** Compose merges sequences by a unique key (target for volumes, published port for ports). */
function mergeSequence(base, overlay, field) {
  const result = [...base];
  for (const item of overlay) {
    const key = composeItemKey(item);
    const index = result.findIndex((existing) => composeItemKey(existing) === key);
    if (index >= 0 && isPlainObject(item) && isPlainObject(result[index])) {
      result[index] = mergeComposeValue(result[index], item, field);
    } else if (index >= 0) {
      result[index] = item;
    } else {
      result.push(item);
    }
  }
  return result;
}

/**
 * @param {unknown} base
 * @param {unknown} overlay
 * @param {string} [field]
 */
function mergeComposeValue(base, overlay, field = "") {
  if (overlay instanceof ResetValue) return overlay.value;
  if (Array.isArray(overlay)) {
    return Array.isArray(base) ? mergeSequence(base, overlay, field) : overlay.slice();
  }
  if (isPlainObject(overlay)) {
    const result = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(overlay)) {
      result[key] = mergeComposeValue(result[key], value, key);
    }
    return result;
  }
  return overlay;
}

/** @param {{ base: unknown, overlay: unknown }} parsed */
export function mergeComposeFiles(parsed) {
  return mergeComposeValue(parsed.base, parsed.overlay);
}

function hasResourceLimits(service) {
  const limits = service?.deploy?.resources?.limits;
  return Boolean(limits?.cpus && limits?.memory);
}

function volumeTargets(service) {
  return (service?.volumes ?? []).map((volume) => composeItemKey(volume, "volumes"));
}

function networkNames(service) {
  const networks = service?.networks;
  if (Array.isArray(networks)) return networks.map(String);
  if (isPlainObject(networks)) return Object.keys(networks);
  return [];
}

function publishedPorts(service) {
  return (service?.ports ?? []).flatMap((port) => {
    if (typeof port === "string") return [port.split(":").pop()];
    if (isPlainObject(port) && port.published !== undefined) return [String(port.published)];
    return [];
  });
}

/**
 * Behavioral assertions on a resolved compose config. Each check answers an
 * acceptance criterion from Issues 385/386/387 rather than checking that a
 * particular line of YAML exists.
 *
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
export function productionTopologyErrors(config) {
  const errors = [];
  const services = config.services ?? {};

  for (const name of ["postgres", "redis", "migration", "api", "proxy"]) {
    if (!services[name]) errors.push(`missing required service: ${name}`);
  }
  if (errors.length > 0) return errors;

  for (const name of ["postgres", "redis", "migration", "api", "proxy"]) {
    const service = services[name];
    if (!hasResourceLimits(service)) errors.push(`${name} has no CPU and memory limits`);
    if (!service.restart) errors.push(`${name} has no restart policy`);
  }

  const api = services.api;
  if (api.image === "node:22-alpine") {
    errors.push("api still uses the development node:22-alpine image");
  }
  if ((api.ports ?? []).length > 0) errors.push("api publishes a host port");
  if (api.working_dir === "/repo") errors.push("api still uses the development working directory");
  if ((api.command ?? []).length > 0)
    errors.push("api still uses the development hot-reload command");
  const apiVolumes = api.volumes ?? [];
  if (
    apiVolumes.some(
      (volume) =>
        (typeof volume === "string" && (volume.startsWith("./") || volume.startsWith("."))) ||
        volume?.type === "bind",
    )
  ) {
    errors.push("api bind-mounts host source code");
  }
  if (api.environment?.TRUST_PROXY !== "true") {
    errors.push("api does not trust the proxy's forwarded protocol header");
  }

  for (const [name, target] of [
    ["postgres", "/var/lib/postgresql/data"],
    ["redis", "/data"],
  ]) {
    const service = services[name];
    if ((service.ports ?? []).length > 0) errors.push(`${name} publishes a host port`);
    if (!volumeTargets(service).includes(target)) {
      errors.push(`${name} has no persistent volume at ${target}`);
    }
  }

  const proxy = services.proxy;
  const published = publishedPorts(proxy);
  if (!published.includes("80") || !published.includes("443")) {
    errors.push("proxy must publish both HTTP and HTTPS");
  }
  const targets = volumeTargets(proxy);
  if (!targets.includes("/etc/nginx/nginx.conf")) errors.push("proxy does not mount nginx.conf");
  if (!targets.includes("/etc/nginx/certs"))
    errors.push("proxy does not mount the certificate directory");
  if (!targets.includes("/var/www/certbot"))
    errors.push("proxy does not serve ACME challenge files");
  if (!networkNames(proxy).includes("verixa-internal")) {
    errors.push("proxy is not attached to the internal compose network");
  }

  return errors;
}

function main() {
  const [, , command, ...argv] = process.argv;
  if (command !== "--check" || !argv[0]) {
    throw new Error("usage: compose-config.mjs --check <resolved-compose.json>");
  }
  const config = JSON.parse(readFileSync(argv[0], "utf8"));
  const errors = productionTopologyErrors(config);
  if (errors.length > 0) {
    for (const error of errors) console.error(`compose-config: ${error}`);
    process.exit(1);
  }
  console.log("compose-config: production topology verified");
}

if (process.argv[1] && process.argv[1].endsWith("compose-config.mjs")) {
  try {
    main();
  } catch (error) {
    console.error(`compose-config: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
