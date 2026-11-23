import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { validateChartSpec } from "../../packages/design-systems/core/compositions/Charts.validation";
import type { ChartConfig } from "../../packages/design-systems/core/compositions/charting/types";
import { dashboardEvalCase } from "./corpus";
import type {
  DashboardEvalCase,
  DashboardEvalCheck,
  DashboardEvalReport,
  DashboardEvalSubmission,
  DashboardExpectedValue,
} from "./types";

export * from "./corpus";
export type * from "./types";

const BANNED_SOURCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /from\s+["']ag-charts-/u, label: "direct AG Charts import" },
  { pattern: /compositions\/charting\//u, label: "internal charting import" },
  { pattern: /AgChartsHost/u, label: "internal AG Charts host access" },
  { pattern: /\bAgChartOptions\b/u, label: "raw AG Charts option type" },
];

export async function evaluateDashboardSubmission(input: {
  evalCase: DashboardEvalCase;
  submission: DashboardEvalSubmission;
  sourceRoot: string;
}): Promise<DashboardEvalReport> {
  const evalCase = input.evalCase;
  const submission = validateDashboardSubmission(input.submission);
  const checks: DashboardEvalCheck[] = [];
  const validCharts = new Map<string, ChartConfig>();

  checks.push(
    check(
      "case",
      "Submission targets the requested corpus case",
      5,
      submission.caseId === evalCase.id,
      {
        hardFailure: true,
        detail: submission.caseId === evalCase.id ? undefined : `received ${submission.caseId}`,
      },
    ),
  );

  const chartErrors: string[] = [];
  const chartIds = new Set<string>();
  for (const chart of submission.charts) {
    if (chartIds.has(chart.id)) {
      chartErrors.push(`duplicate chart id: ${chart.id}`);
      continue;
    }
    chartIds.add(chart.id);
    try {
      validCharts.set(chart.id, validateChartSpec(chart.config));
    } catch (error) {
      chartErrors.push(`${chart.id}: ${errorMessage(error)}`);
    }
  }
  checks.push(
    check(
      "chart-contract",
      "Every chart passes the production spec validator",
      20,
      chartErrors.length === 0,
      {
        hardFailure: true,
        detail: chartErrors.join("; ") || undefined,
      },
    ),
  );

  const presentFamilies = new Set([...validCharts.values()].map((chart) => chart.family));
  const missingFamilies = evalCase.requiredFamilies.filter(
    (family) => !presentFamilies.has(family),
  );
  checks.push(
    check("families", "Requested chart families are present", 10, missingFamilies.length === 0, {
      hardFailure: true,
      detail: missingFamilies.length > 0 ? `missing: ${missingFamilies.join(", ")}` : undefined,
    }),
  );

  const ownedSourceFiles = await enumerateSourceFiles(input.sourceRoot);
  const sourceResult = await inspectSourceFiles(
    input.sourceRoot,
    ownedSourceFiles,
    submission.entryFile,
  );
  const declaredSourceFiles = submission.sourceFiles.toSorted();
  if (JSON.stringify(declaredSourceFiles) !== JSON.stringify(ownedSourceFiles)) {
    sourceResult.issues.push(
      `submission.sourceFiles must exactly match the runner-owned source set: ${ownedSourceFiles.join(", ")}`,
    );
  }
  checks.push(
    check(
      "public-api",
      "Source uses only public chart composition APIs",
      15,
      sourceResult.issues.length === 0,
      {
        hardFailure: true,
        detail: sourceResult.issues.join("; ") || undefined,
      },
    ),
  );

  const maximumFiles = evalCase.policy.maxSourceFiles ?? 8;
  checks.push(
    check(
      "scope",
      "Implementation stays within the expected file budget",
      5,
      ownedSourceFiles.length > 0 && ownedSourceFiles.length <= maximumFiles,
      {
        detail: `${ownedSourceFiles.length}/${maximumFiles} files`,
      },
    ),
  );

  const boundControls = new Set(submission.controlBindings.map((binding) => binding.controlId));
  const declaredControls = new Set(
    [...validCharts.values()].flatMap(
      (chart) => chart.controls?.map((control) => control.id) ?? [],
    ),
  );
  const missingControls = evalCase.requiredControls.filter(
    (id) => !declaredControls.has(id) || !boundControls.has(id),
  );
  const undeclaredControlBindings = [...boundControls].filter((id) => !declaredControls.has(id));
  checks.push(
    check(
      "controls",
      "Required controls have host-owned bindings",
      10,
      missingControls.length === 0 && undeclaredControlBindings.length === 0,
      {
        detail: formatMissing(missingControls, undeclaredControlBindings),
      },
    ),
  );

  const actionBindings = new Map(
    submission.actionBindings.map((binding) => [binding.actionId, binding.behavior]),
  );
  const declaredActions = new Set(
    [...validCharts.values()]
      .map((chart) => chart.segmentAction?.actionId)
      .filter((id): id is string => id !== undefined),
  );
  const missingActions = evalCase.requiredActions.filter(
    (id) =>
      !declaredActions.has(id) || !actionBindings.has(id) || actionBindings.get(id) === "none",
  );
  const unboundDeclaredActions = [...declaredActions].filter(
    (id) => !actionBindings.has(id) || actionBindings.get(id) === "none",
  );
  checks.push(
    check(
      "actions",
      "Opaque chart actions resolve to explicit host behavior",
      10,
      missingActions.length === 0 && unboundDeclaredActions.length === 0,
      {
        detail: formatMissing(missingActions, unboundDeclaredActions),
      },
    ),
  );

  const valueFailures = evalCase.expectedValues.flatMap((expectation) =>
    evaluateExpectedValue(validCharts, expectation),
  );
  checks.push(
    check(
      "aggregations",
      "Declared chart values match deterministic expectations",
      15,
      valueFailures.length === 0,
      {
        hardFailure: true,
        detail: valueFailures.join("; ") || undefined,
      },
    ),
  );

  const policyFailures = evaluatePolicies(evalCase, validCharts, boundControls);
  checks.push(
    check(
      "data-policy",
      "Currency and missing-value policies are preserved",
      5,
      policyFailures.length === 0,
      {
        hardFailure: true,
        detail: policyFailures.join("; ") || undefined,
      },
    ),
  );

  checks.push(
    check(
      "first-attempt",
      "Submission was valid on the first agent attempt",
      3,
      submission.firstAttempt,
    ),
  );
  checks.push(
    check(
      "repair-budget",
      "Submission required at most one repair",
      2,
      submission.repairAttempts <= 1,
      {
        detail: `${submission.repairAttempts} repairs`,
      },
    ),
  );

  const hardFailures = checks.reduce<string[]>((failures, entry) => {
    if (entry.hardFailure && !entry.passed) failures.push(entry.id);
    return failures;
  }, []);
  const score = checks.reduce((total, entry) => total + entry.earned, 0);
  const maximumScore = checks.reduce((total, entry) => total + entry.points, 0);
  return {
    caseId: evalCase.id,
    score,
    maximumScore,
    passed: hardFailures.length === 0 && score >= 80,
    hardFailures,
    checks,
    summary: {
      validChartCount: validCharts.size,
      sourceFileCount: ownedSourceFiles.length,
      repairAttempts: submission.repairAttempts,
      firstAttempt: submission.firstAttempt,
    },
  };
}

export async function evaluateDashboardSubmissionFile(input: {
  caseId: string;
  submissionPath: string;
}) {
  const evalCase = dashboardEvalCase(input.caseId);
  if (!evalCase) throw new Error(`Unknown dashboard eval case: ${input.caseId}`);
  const absolutePath = path.resolve(input.submissionPath);
  const submission = validateDashboardSubmission(JSON.parse(await readFile(absolutePath, "utf8")));
  return evaluateDashboardSubmission({
    evalCase,
    submission,
    sourceRoot: path.dirname(absolutePath),
  });
}

async function inspectSourceFiles(sourceRoot: string, sourceFiles: string[], entryFile: string) {
  const issues: string[] = [];
  const seen = new Set<string>();
  const readableSourceFiles: string[] = [];
  for (const relativePath of sourceFiles) {
    if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
      issues.push(`${relativePath}: path must remain inside the submission directory`);
      continue;
    }
    if (seen.has(relativePath)) {
      issues.push(`${relativePath}: duplicate source file`);
      continue;
    }
    seen.add(relativePath);
    readableSourceFiles.push(relativePath);
  }
  const sources = await Promise.all(
    readableSourceFiles.map(async (relativePath) => {
      try {
        return {
          relativePath,
          source: await readFile(path.join(sourceRoot, relativePath), "utf8"),
        };
      } catch (error) {
        issues.push(`${relativePath}: ${errorMessage(error)}`);
        return undefined;
      }
    }),
  );
  for (const result of sources) {
    if (!result) continue;
    const { relativePath, source } = result;
    for (const banned of BANNED_SOURCE_PATTERNS) {
      if (banned.pattern.test(source)) issues.push(`${relativePath}: ${banned.label}`);
    }
  }
  if (sourceFiles.length === 0) issues.push("submission must declare at least one source file");
  if (!sourceFiles.includes(entryFile)) {
    issues.push(`${entryFile}: entry file was not found in the runner-owned source set`);
  } else {
    const entrySource = sources.find((result) => result?.relativePath === entryFile)?.source;
    if (entrySource === undefined) return { issues };
    if (!/\bChartComposition\b/u.test(entrySource)) {
      issues.push(`${entryFile}: entry file must render through ChartComposition`);
    }
    if (!/["']\.\/submission\.json["']/u.test(entrySource)) {
      issues.push(`${entryFile}: entry file must import the exact evaluated submission.json`);
    }
  }
  return { issues };
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  ".scratch",
  "storybook-static",
]);

async function enumerateSourceFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) return;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (entry.isSymbolicLink())
          throw new Error(`${relative}: candidate sources must not contain symlinks`);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name)))
          output.push(relative);
      }),
    );
  }
  await visit(root);
  return output.toSorted();
}

export function validateDashboardSubmission(value: unknown): DashboardEvalSubmission {
  const object = requireRecord(value, "submission");
  rejectKeys(
    object,
    new Set([
      "version",
      "caseId",
      "entryFile",
      "firstAttempt",
      "repairAttempts",
      "elapsedMs",
      "sourceFiles",
      "charts",
      "controlBindings",
      "actionBindings",
    ]),
    "submission",
  );
  if (object.version !== 1) throw new Error("submission.version must be 1");
  const entryFile = safeRelativePath(
    requireText(object.entryFile, "submission.entryFile"),
    "submission.entryFile",
  );
  const sourceFiles = requireList(object.sourceFiles, "submission.sourceFiles", (item, index) =>
    safeRelativePath(
      requireText(item, `submission.sourceFiles[${index}]`),
      `submission.sourceFiles[${index}]`,
    ),
  );
  uniqueStrings(sourceFiles, "submission.sourceFiles");
  const charts = requireList(object.charts, "submission.charts", (item, index) => {
    const chart = requireRecord(item, `submission.charts[${index}]`);
    rejectKeys(chart, new Set(["id", "config"]), `submission.charts[${index}]`);
    return { id: requireText(chart.id, `submission.charts[${index}].id`), config: chart.config };
  });
  const controlBindings = requireList(
    object.controlBindings,
    "submission.controlBindings",
    (item, index) => {
      const binding = requireRecord(item, `submission.controlBindings[${index}]`);
      rejectKeys(
        binding,
        new Set(["controlId", "behavior"]),
        `submission.controlBindings[${index}]`,
      );
      const behavior = binding.behavior;
      if (behavior !== "filter" && behavior !== "query" && behavior !== "projection")
        throw new Error(`submission.controlBindings[${index}].behavior is unsupported`);
      return {
        controlId: requireText(binding.controlId, `submission.controlBindings[${index}].controlId`),
        behavior: behavior as "filter" | "query" | "projection",
      };
    },
  );
  uniqueStrings(
    controlBindings.map((binding) => binding.controlId),
    "submission.controlBindings controlId",
  );
  const actionBindings = requireList(
    object.actionBindings,
    "submission.actionBindings",
    (item, index) => {
      const binding = requireRecord(item, `submission.actionBindings[${index}]`);
      rejectKeys(binding, new Set(["actionId", "behavior"]), `submission.actionBindings[${index}]`);
      const behavior = binding.behavior;
      if (
        behavior !== "navigate" &&
        behavior !== "filter" &&
        behavior !== "detail_panel" &&
        behavior !== "table" &&
        behavior !== "none"
      )
        throw new Error(`submission.actionBindings[${index}].behavior is unsupported`);
      return {
        actionId: requireText(binding.actionId, `submission.actionBindings[${index}].actionId`),
        behavior: behavior as "navigate" | "filter" | "detail_panel" | "table" | "none",
      };
    },
  );
  uniqueStrings(
    actionBindings.map((binding) => binding.actionId),
    "submission.actionBindings actionId",
  );
  if (typeof object.firstAttempt !== "boolean")
    throw new Error("submission.firstAttempt must be boolean");
  if (!Number.isInteger(object.repairAttempts) || Number(object.repairAttempts) < 0)
    throw new Error("submission.repairAttempts must be a non-negative integer");
  if (
    object.elapsedMs !== undefined &&
    (!Number.isFinite(object.elapsedMs) || Number(object.elapsedMs) < 0)
  )
    throw new Error("submission.elapsedMs must be a non-negative finite number");
  return {
    version: 1,
    caseId: requireText(object.caseId, "submission.caseId"),
    entryFile,
    firstAttempt: object.firstAttempt,
    repairAttempts: Number(object.repairAttempts),
    elapsedMs: object.elapsedMs === undefined ? undefined : Number(object.elapsedMs),
    sourceFiles,
    charts,
    controlBindings,
    actionBindings,
  };
}

function requireRecord(value: unknown, pathName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${pathName} must be an object`);
  return value as Record<string, unknown>;
}
function requireText(value: unknown, pathName: string) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${pathName} must be a non-empty string`);
  return value;
}
function requireList<T>(
  value: unknown,
  pathName: string,
  map: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) throw new Error(`${pathName} must be an array`);
  return value.map(map);
}
function rejectKeys(object: Record<string, unknown>, allowed: Set<string>, pathName: string) {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${pathName}.${unknown} is not supported`);
}
function safeRelativePath(value: string, pathName: string) {
  if (path.isAbsolute(value) || value.split(/[\\/]/u).includes(".."))
    throw new Error(`${pathName} must remain inside the submission directory`);
  return value.split(path.sep).join("/");
}
function uniqueStrings(values: string[], pathName: string) {
  if (new Set(values).size !== values.length) throw new Error(`${pathName} values must be unique`);
}

function evaluateExpectedValue(
  charts: Map<string, ChartConfig>,
  expectation: DashboardExpectedValue,
) {
  const chart = charts.get(expectation.chartId);
  if (!chart) return [`${expectation.chartId}: chart not found`];
  const data = "data" in chart ? chart.data : [];
  const datum = data.find((entry) => "id" in entry && entry.id === expectation.datumId);
  if (!datum) return [`${expectation.chartId}/${expectation.datumId}: datum not found`];
  const value = expectation.key in datum ? datum[expectation.key as keyof typeof datum] : undefined;
  if (typeof value !== "number") {
    return [
      `${expectation.chartId}/${expectation.datumId}.${expectation.key}: numeric value not found`,
    ];
  }
  const numericValue = Number(value);
  const tolerance = expectation.tolerance ?? 0;
  return Math.abs(numericValue - expectation.expected) <= tolerance
    ? []
    : [
        `${expectation.chartId}/${expectation.datumId}.${expectation.key}: expected ${expectation.expected}, received ${numericValue}`,
      ];
}

function evaluatePolicies(
  evalCase: DashboardEvalCase,
  charts: Map<string, ChartConfig>,
  boundControls: Set<string>,
) {
  const failures: string[] = [];
  if ((evalCase.policy.currencies?.length ?? 0) > 1 && !boundControls.has("currency")) {
    failures.push("mixed-currency case requires a bound currency control");
  }
  if (evalCase.policy.preserveMissing && evalCase.requiredFamilies.includes("stacked_timeline")) {
    const timelines = [...charts.values()].filter((chart) => chart.family === "stacked_timeline");
    const hasMissing = timelines.some((chart) =>
      chart.data.some((datum) => Object.values(datum.values).some((value) => value === null)),
    );
    if (!hasMissing) failures.push("sparse timeline case must preserve at least one null value");
  }
  return failures;
}

function check(
  id: string,
  label: string,
  points: number,
  passed: boolean,
  options: { hardFailure?: boolean; detail?: string } = {},
): DashboardEvalCheck {
  return {
    id,
    label,
    points,
    earned: passed ? points : 0,
    passed,
    hardFailure: options.hardFailure,
    detail: options.detail,
  };
}

function formatMissing(required: string[], declared: string[]) {
  const parts = [
    required.length > 0 ? `missing required: ${required.join(", ")}` : "",
    declared.length > 0 ? `unbound declared: ${declared.join(", ")}` : "",
  ].filter(Boolean);
  return parts.join("; ") || undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
