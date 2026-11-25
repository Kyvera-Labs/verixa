import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mergeComposeFiles,
  parseComposeOverlay,
  productionTopologyErrors,
} from "../../infra/ci/compose-config.mjs";

interface ComposeService {
  image?: string;
  networks?: unknown;
  ports?: unknown;
  volumes?: unknown;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

function apiService(config: ComposeConfig): ComposeService {
  const api = config.services.api;
  if (!api) throw new Error("api service missing from resolved config");
  return api;
}

const REPO_ROOT = resolve(__dirname, "../..");
const BASE = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8");
const OVERLAY = readFileSync(resolve(REPO_ROOT, "docker-compose.prod.yml"), "utf8");
const NGINX = readFileSync(resolve(REPO_ROOT, "infra/nginx/nginx.conf"), "utf8");

function resolved(base = BASE, overlay = OVERLAY): ComposeConfig {
  return mergeComposeFiles(parseComposeOverlay(base, overlay)) as ComposeConfig;
}

describe("Production compose overlay (Issue 385 / #497)", () => {
  it("resolves to a production topology with no dev ports or source mounts", () => {
    expect(productionTopologyErrors(resolved())).toEqual([]);
  });

  it("accepts the object form of networks produced by docker compose config", () => {
    const config = resolved();
    config.services.proxy!.networks = { "verixa-internal": null };
    expect(productionTopologyErrors(config)).toEqual([]);

    config.services.proxy!.networks = { default: null };
    expect(productionTopologyErrors(config)).toContain(
      "proxy is not attached to the internal compose network",
    );
  });

  it("accepts the object form of ports produced by docker compose config", () => {
    const config = resolved();
    config.services.proxy!.ports = [
      { mode: "ingress", published: "80", target: 80, protocol: "tcp" },
      { mode: "ingress", published: "443", target: 443, protocol: "tcp" },
    ];
    expect(productionTopologyErrors(config)).toEqual([]);

    config.services.proxy!.ports = [{ target: 80, protocol: "tcp" }];
    expect(productionTopologyErrors(config)).toContain("proxy must publish both HTTP and HTTPS");
  });

  it("catches a lost port reset before it reaches the host", () => {
    const errors = productionTopologyErrors(
      resolved(BASE, OVERLAY.replace(/ports: !reset \[\]/g, "")),
    );
    expect(errors).toContain("api publishes a host port");
    expect(errors).toContain("postgres publishes a host port");
    expect(errors).toContain("redis publishes a host port");
  });

  it("catches a lost volume reset that would remount the source tree", () => {
    const regressed = OVERLAY.replace(
      "    volumes: !reset []\n    environment:\n      NODE_ENV: production",
      "    environment:\n      NODE_ENV: production",
    );
    expect(regressed).not.toBe(OVERLAY);
    const config = resolved(BASE, regressed);
    expect(apiService(config).volumes).toContain(".:/repo");
    expect(productionTopologyErrors(config)).toContain("api bind-mounts host source code");
  });

  it("catches a dev image sneaking back into the api service", () => {
    const config = resolved();
    apiService(config).image = "node:22-alpine";
    expect(productionTopologyErrors(config)).toContain(
      "api still uses the development node:22-alpine image",
    );
  });

  it("terminates TLS at the edge and forwards to the internal api service", () => {
    expect(NGINX).toMatch(/listen 80;/);
    expect(NGINX).toMatch(/return 301 https:\/\/\$host\$request_uri;/);
    expect(NGINX).toMatch(/listen 443 ssl;/);
    expect(NGINX).toMatch(/ssl_certificate \/etc\/nginx\/certs\/fullchain\.pem;/);
    expect(NGINX).toMatch(/proxy_pass http:\/\/api_backend/);
    expect(NGINX).toMatch(/server api:3000;/);
    expect(NGINX).toMatch(/\.well-known\/acme-challenge/);
  });
});
