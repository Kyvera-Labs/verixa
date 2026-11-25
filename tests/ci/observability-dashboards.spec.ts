import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { REPO_ROOT } from "./helpers/ci-tooling.js";

interface GrafanaPanel {
  id: number;
  title: string;
  type: string;
  datasource?: { type: string; uid: string };
  targets?: Array<{ refId: string; expr: string }>;
}

interface GrafanaDashboard {
  uid: string;
  title: string;
  schemaVersion: number;
  editable: boolean;
  panels: GrafanaPanel[];
}

describe("Observability dashboards-as-code (#471)", () => {
  it("provisions Prometheus datasource and file-based Verixa dashboards", async () => {
    const dsPath = path.resolve(
      REPO_ROOT,
      "infra/observability/grafana-provisioning/datasources/prometheus.yml",
    );
    const dsConfig = parseYaml(await fs.readFile(dsPath, "utf-8")) as {
      datasources: Array<{
        name: string;
        type: string;
        uid: string;
        isDefault: boolean;
        url: string;
      }>;
    };

    expect(dsConfig.datasources).toHaveLength(1);
    expect(dsConfig.datasources[0]).toMatchObject({
      name: "Prometheus",
      type: "prometheus",
      uid: "prometheus",
      isDefault: true,
      url: "http://prometheus:9090",
    });

    const dashProvPath = path.resolve(
      REPO_ROOT,
      "infra/observability/grafana-provisioning/dashboards/dashboards.yml",
    );
    const dashProv = parseYaml(await fs.readFile(dashProvPath, "utf-8")) as {
      providers: Array<{ name: string; type: string; options: { path: string } }>;
    };
    expect(dashProv.providers[0]?.type).toBe("file");
    expect(dashProv.providers[0]?.options.path).toBe("/var/lib/grafana/dashboards");
  });

  it("validates HTTP golden signals and business metrics dashboards against Prometheus datasource", async () => {
    const dashboardsDir = path.resolve(REPO_ROOT, "infra/observability/dashboards");
    const files = ["http-golden-signals.json", "business-metrics.json"];

    for (const file of files) {
      const dashboard = JSON.parse(
        await fs.readFile(path.join(dashboardsDir, file), "utf-8"),
      ) as GrafanaDashboard;

      expect(dashboard.uid).toBeTruthy();
      expect(dashboard.title).toBeTruthy();
      expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(36);
      expect(dashboard.editable).toBe(false);
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(4);

      for (const panel of dashboard.panels) {
        expect(panel.datasource?.uid).toBe("prometheus");
        expect(panel.targets && panel.targets.length).toBeGreaterThan(0);
        for (const target of panel.targets ?? []) {
          expect(target.expr.trim().length).toBeGreaterThan(0);
        }
      }
    }

    const goldenSignals = JSON.parse(
      await fs.readFile(path.join(dashboardsDir, "http-golden-signals.json"), "utf-8"),
    ) as GrafanaDashboard;
    const titles = goldenSignals.panels.map((p) => p.title.toLowerCase()).join(" | ");
    expect(titles).toContain("latency");
    expect(titles).toContain("traffic");
    expect(titles).toContain("errors");
    expect(titles).toContain("saturation");
    expect(titles).toContain("health");
  });

  it("defines healthy Prometheus and Grafana services in docker-compose.observability.yml with valid mounts", async () => {
    const composePath = path.resolve(REPO_ROOT, "infra/docker/docker-compose.observability.yml");
    const composeDir = path.dirname(composePath);
    const parsed = parseYaml(await fs.readFile(composePath, "utf-8")) as {
      services: Record<string, { healthcheck?: unknown; volumes?: string[] }>;
    };

    expect(parsed.services["prometheus"]?.healthcheck).toBeDefined();
    expect(parsed.services["grafana"]?.healthcheck).toBeDefined();

    for (const svcName of ["prometheus", "grafana"]) {
      const volumes = parsed.services[svcName]?.volumes ?? [];
      for (const vol of volumes) {
        const hostPart = vol.split(":")[0] ?? "";
        if (hostPart.startsWith(".")) {
          const resolved = path.resolve(composeDir, hostPart);
          expect(existsSync(resolved), `Missing compose mount path: ${resolved}`).toBe(true);
        }
      }
    }
  });
});
