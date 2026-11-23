import { describe, expect, it } from "vitest";

import {
  aggregatePipelineMetrics,
  calculateDurationSeconds,
  formatDuration,
  renderDashboardMarkdown,
  type WorkflowRun,
} from "./generate.js";

describe("CI Dashboard Generator", () => {
  const baseDate = new Date("2026-11-19T12:00:00Z");

  const createRun = (partial: Partial<WorkflowRun>): WorkflowRun => ({
    id: 1,
    name: "CI",
    head_branch: "main",
    head_sha: "abcdef1234567890",
    event: "push",
    status: "completed",
    conclusion: "success",
    created_at: new Date(baseDate.getTime() - 2 * 3600 * 1000).toISOString(),
    updated_at: new Date(baseDate.getTime() - 2 * 3600 * 1000 + 120 * 1000).toISOString(),
    html_url: "https://github.com/Kyvera-Labs/verixa/actions/runs/1",
    run_number: 10,
    actor: { login: "test-user" },
    head_commit: {
      id: "abcdef1",
      message: "feat: add pipeline metrics\n\nDetailed body",
      author: { name: "Test Author", email: "test@example.com" },
    },
    ...partial,
  });

  describe("calculateDurationSeconds", () => {
    it("computes duration in seconds from created_at and updated_at", () => {
      const run = createRun({
        created_at: "2026-11-19T10:00:00Z",
        updated_at: "2026-11-19T10:02:30Z",
      });
      expect(calculateDurationSeconds(run)).toBe(150);
    });

    it("prefers run_started_at when present", () => {
      const run = createRun({
        created_at: "2026-11-19T09:55:00Z",
        run_started_at: "2026-11-19T10:00:00Z",
        updated_at: "2026-11-19T10:01:00Z",
      });
      expect(calculateDurationSeconds(run)).toBe(60);
    });

    it("returns 0 on invalid or reversed timestamps", () => {
      const run = createRun({
        created_at: "invalid",
        updated_at: "invalid",
      });
      expect(calculateDurationSeconds(run)).toBe(0);
    });
  });

  describe("formatDuration", () => {
    it("formats seconds under a minute", () => {
      expect(formatDuration(45)).toBe("45s");
    });

    it("formats minutes and seconds", () => {
      expect(formatDuration(135)).toBe("2m 15s");
    });
  });

  describe("aggregatePipelineMetrics", () => {
    it("handles empty run list gracefully", () => {
      const report = aggregatePipelineMetrics([], { now: baseDate, windowDays: 30 });
      expect(report.totalRuns).toBe(0);
      expect(report.completedRuns).toBe(0);
      expect(report.overallPassRate).toBe(100);
      expect(report.overallMeanDurationSeconds).toBe(0);
      expect(report.recentFailures).toHaveLength(0);
      expect(Object.keys(report.workflows)).toHaveLength(0);
    });

    it("filters out runs older than the configured window (30 days)", () => {
      const freshRun = createRun({
        id: 1,
        created_at: new Date(baseDate.getTime() - 10 * 24 * 3600 * 1000).toISOString(),
        updated_at: new Date(baseDate.getTime() - 10 * 24 * 3600 * 1000 + 60 * 1000).toISOString(),
      });
      const oldRun = createRun({
        id: 2,
        created_at: new Date(baseDate.getTime() - 35 * 24 * 3600 * 1000).toISOString(),
        updated_at: new Date(baseDate.getTime() - 35 * 24 * 3600 * 1000 + 60 * 1000).toISOString(),
      });

      const report = aggregatePipelineMetrics([freshRun, oldRun], {
        now: baseDate,
        windowDays: 30,
      });
      expect(report.totalRuns).toBe(1);
      expect(report.completedRuns).toBe(1);
    });

    it("computes accurate pass rate, duration, and workflow groupings", () => {
      const run1 = createRun({
        id: 101,
        name: "CI",
        conclusion: "success",
        created_at: new Date(baseDate.getTime() - 100000).toISOString(),
        updated_at: new Date(baseDate.getTime() - 40000).toISOString(), // 60s
      });
      const run2 = createRun({
        id: 102,
        name: "CI",
        conclusion: "failure",
        created_at: new Date(baseDate.getTime() - 90000).toISOString(),
        updated_at: new Date(baseDate.getTime() - 50000).toISOString(), // 40s
      });
      const run3 = createRun({
        id: 103,
        name: "Release",
        conclusion: "success",
        created_at: new Date(baseDate.getTime() - 80000).toISOString(),
        updated_at: new Date(baseDate.getTime() - 60000).toISOString(), // 20s
      });

      const report = aggregatePipelineMetrics([run1, run2, run3], {
        now: baseDate,
        windowDays: 30,
      });

      expect(report.totalRuns).toBe(3);
      expect(report.successfulRuns).toBe(2);
      expect(report.failedRuns).toBe(1);
      // 2 / 3 = 66.7%
      expect(report.overallPassRate).toBe(66.7);
      // (60 + 40 + 20) / 3 = 40s
      expect(report.overallMeanDurationSeconds).toBe(40);

      // Workflow metrics
      expect(report.workflows["CI"]?.totalRuns).toBe(2);
      expect(report.workflows["CI"]?.passRate).toBe(50.0);
      expect(report.workflows["CI"]?.meanDurationSeconds).toBe(50);

      expect(report.workflows["Release"]?.totalRuns).toBe(1);
      expect(report.workflows["Release"]?.passRate).toBe(100.0);
      expect(report.workflows["Release"]?.meanDurationSeconds).toBe(20);

      // Recent failures
      expect(report.recentFailures).toHaveLength(1);
      expect(report.recentFailures[0]?.runId).toBe(102);
      expect(report.recentFailures[0]?.workflow).toBe("CI");
      expect(report.recentFailures[0]?.commitSha).toBe("abcdef1");
    });
  });

  describe("renderDashboardMarkdown", () => {
    it("renders table headers and summary cards", () => {
      const run = createRun({
        id: 201,
        name: "CI",
        conclusion: "failure",
        head_commit: {
          id: "123456789",
          message: "fix: resolve edge case",
          author: { name: "Alice", email: "alice@example.com" },
        },
      });

      const report = aggregatePipelineMetrics([run], { now: baseDate, windowDays: 30 });
      const md = renderDashboardMarkdown(report);

      expect(md).toContain("# CI/CD Pipeline Health Dashboard");
      expect(md).toContain("Overall Pass Rate");
      expect(md).toContain("Per-Workflow Performance Breakdown");
      expect(md).toContain("Recent Failures");
      expect(md).toContain("fix: resolve edge case");
      expect(md).toContain("Alice");
    });
  });
});
