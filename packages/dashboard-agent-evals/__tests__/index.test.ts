import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { dashboardEvalCorpus, dashboardEvalCase } from "../corpus";
import { evaluateDashboardSubmission, validateDashboardSubmission } from "../index";
import type { DashboardEvalSubmission } from "../types";
import type { DashboardEvalReport } from "../types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(HERE, "../fixtures/vendor-spend-overview");

describe("dashboard agent evaluation harness", () => {
  it("ships a ten-scenario corpus with stable unique ids", () => {
    expect(dashboardEvalCorpus).toHaveLength(10);
    expect(new Set(dashboardEvalCorpus.map((entry) => entry.id)).size).toBe(10);
    expect(dashboardEvalCorpus.every((entry) => entry.requiredFamilies.length > 0)).toBe(true);
  });

  it("awards a passing score to the canonical public-API submission", async () => {
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission: await fixtureSubmission(),
      sourceRoot: FIXTURE_ROOT,
    });

    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.hardFailures).toEqual([]);
    expect(report.summary.validChartCount).toBe(4);
  });

  it("keeps the visual result fixture paired with evaluator output", async () => {
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission: await fixtureSubmission(),
      sourceRoot: FIXTURE_ROOT,
    });
    const visualReport = JSON.parse(
      await readFile(path.join(FIXTURE_ROOT, "report.json"), "utf8"),
    ) as DashboardEvalReport;

    expect(visualReport).toEqual(report);
  });

  it("fails direct vendor-library imports even when chart specs are valid", async () => {
    const submission = await fixtureSubmission();
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "dashboard-eval-unsafe-"));
    await writeFile(
      path.join(sourceRoot, "Dashboard.tsx"),
      'import submission from "./submission.json";\nimport { AgCharts } from "ag-charts-react";\nexport const ChartComposition = AgCharts;\nvoid submission;\n',
    );
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission,
      sourceRoot,
    });

    expect(report.passed).toBe(false);
    expect(report.hardFailures).toContain("public-api");
    expect(report.checks.find((entry) => entry.id === "public-api")?.detail).toContain(
      "direct AG Charts import",
    );
  });

  it("does not award bindings that are absent from the evaluated chart specs", async () => {
    const submission = await fixtureSubmission();
    for (const chart of submission.charts) {
      const config = chart.config as { controls?: unknown; segmentAction?: unknown };
      delete config.controls;
      delete config.segmentAction;
    }
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission,
      sourceRoot: FIXTURE_ROOT,
    });

    expect(report.checks.find((entry) => entry.id === "controls")?.passed).toBe(false);
    expect(report.checks.find((entry) => entry.id === "actions")?.passed).toBe(false);
  });

  it("strictly validates the versioned submission envelope", async () => {
    const submission = await fixtureSubmission();
    expect(() => validateDashboardSubmission({ ...submission, version: 2 })).toThrow(
      "submission.version must be 1",
    );
    expect(() => validateDashboardSubmission({ ...submission, extra: true })).toThrow(
      "submission.extra is not supported",
    );
    expect(() =>
      validateDashboardSubmission({ ...submission, controlBindings: undefined }),
    ).toThrow("submission.controlBindings must be an array");
  });

  it("fails incorrect aggregation evidence with an actionable datum path", async () => {
    const submission = await fixtureSubmission();
    const spendMix = submission.charts.find((chart) => chart.id === "spend-mix")!;
    const config = spendMix.config as { data: Array<{ id: string; value: number }> };
    config.data.find((datum) => datum.id === "software")!.value = 181_000;
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission,
      sourceRoot: FIXTURE_ROOT,
    });

    expect(report.passed).toBe(false);
    expect(report.hardFailures).toContain("aggregations");
    expect(report.checks.find((entry) => entry.id === "aggregations")?.detail).toContain(
      "spend-mix/software.value",
    );
  });

  it("fails chart validation before scoring a duplicate heatmap coordinate", async () => {
    const submission = await fixtureSubmission();
    const heatmap = submission.charts.find((chart) => chart.id === "category-month")!;
    const config = heatmap.config as { data: Array<Record<string, unknown>> };
    config.data.push({ ...config.data[0], id: "duplicate" });
    const report = await evaluateDashboardSubmission({
      evalCase: dashboardEvalCase("vendor-spend-overview")!,
      submission,
      sourceRoot: FIXTURE_ROOT,
    });

    expect(report.passed).toBe(false);
    expect(report.hardFailures).toContain("chart-contract");
    expect(report.checks.find((entry) => entry.id === "chart-contract")?.detail).toContain(
      "unique xKey/yKey coordinates",
    );
  });
});

async function fixtureSubmission() {
  return JSON.parse(
    await readFile(path.join(FIXTURE_ROOT, "submission.json"), "utf8"),
  ) as DashboardEvalSubmission;
}
