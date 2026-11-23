import type { ChartConfig } from "../../packages/design-systems/core/compositions/charting/types";

export type DashboardEvalFamily = ChartConfig["family"];

export type DashboardEvalCase = {
  id: string;
  title: string;
  prompt: string;
  dataNotes: string[];
  requiredFamilies: DashboardEvalFamily[];
  requiredControls: string[];
  requiredActions: string[];
  expectedValues: DashboardExpectedValue[];
  policy: {
    currencies?: string[];
    preserveMissing?: boolean;
    maxSourceFiles?: number;
  };
};

export type DashboardExpectedValue = {
  chartId: string;
  datumId: string;
  key: "value" | "barValue" | "lineValue" | "low" | "high" | "marker" | "x" | "y";
  expected: number;
  tolerance?: number;
};

export type DashboardEvalSubmission = {
  version: 1;
  caseId: string;
  entryFile: string;
  firstAttempt: boolean;
  repairAttempts: number;
  elapsedMs?: number;
  sourceFiles: string[];
  charts: Array<{ id: string; config: unknown }>;
  controlBindings: Array<{ controlId: string; behavior: "filter" | "query" | "projection" }>;
  actionBindings: Array<{
    actionId: string;
    behavior: "navigate" | "filter" | "detail_panel" | "table" | "none";
  }>;
};

export type DashboardEvalCheck = {
  id: string;
  label: string;
  points: number;
  earned: number;
  passed: boolean;
  hardFailure?: boolean;
  detail?: string;
};

export type DashboardEvalReport = {
  caseId: string;
  score: number;
  maximumScore: number;
  passed: boolean;
  hardFailures: string[];
  checks: DashboardEvalCheck[];
  summary: {
    validChartCount: number;
    sourceFileCount: number;
    repairAttempts: number;
    firstAttempt: boolean;
  };
};
