import type { DashboardEvalCase } from "./types";

export const dashboardEvalCorpus: DashboardEvalCase[] = [
  {
    id: "vendor-spend-overview",
    title: "Vendor spend overview",
    prompt:
      "Build a Vendor Analytics dashboard with spend mix, monthly spend versus transaction volume, category-by-month intensity, vendor concentration, group-by, status filter, as-of date, period and currency controls, and record drill-through.",
    dataNotes: [
      "All supplied values are approved USD transactions.",
      "Use stable category, period, and vendor ids independently from display labels.",
    ],
    requiredFamilies: ["donut", "combined_bar_line", "heatmap", "scatter"],
    requiredControls: ["group-by", "status", "as-of", "period", "currency"],
    requiredActions: ["filter-category", "open-period", "filter-cell", "open-vendor"],
    expectedValues: [
      { chartId: "spend-mix", datumId: "software", key: "value", expected: 182_000 },
      { chartId: "spend-volume", datumId: "apr", key: "barValue", expected: 142_000 },
      { chartId: "spend-volume", datumId: "apr", key: "lineValue", expected: 221 },
      { chartId: "category-month", datumId: "software:apr", key: "value", expected: 96_000 },
    ],
    policy: { currencies: ["USD"], preserveMissing: true, maxSourceFiles: 8 },
  },
  {
    id: "headcount-movement",
    title: "Headcount movement",
    prompt:
      "Show opening headcount, hires, exits, closing headcount, and monthly movement by department.",
    dataNotes: ["Null monthly values mean unavailable evidence, not zero."],
    requiredFamilies: ["waterfall", "stacked_timeline"],
    requiredControls: ["period"],
    requiredActions: ["open-employees"],
    expectedValues: [],
    policy: { preserveMissing: true, maxSourceFiles: 6 },
  },
  {
    id: "compensation-distribution",
    title: "Compensation distribution",
    prompt:
      "Compare compensation ranges and current markers by level, plus employee distribution by level.",
    dataNotes: ["Do not combine currencies."],
    requiredFamilies: ["range_marker", "donut"],
    requiredControls: ["currency"],
    requiredActions: ["open-level"],
    expectedValues: [],
    policy: { currencies: ["USD", "EUR"], maxSourceFiles: 6 },
  },
  {
    id: "recruiting-funnel-proxy",
    title: "Recruiting pipeline",
    prompt:
      "Visualize candidates by stage and weekly stage movement without inventing unsupported funnel semantics.",
    dataNotes: ["Use supported chart families only."],
    requiredFamilies: ["breakdown", "stacked_timeline"],
    requiredControls: ["role"],
    requiredActions: ["filter-stage"],
    expectedValues: [],
    policy: { maxSourceFiles: 6 },
  },
  {
    id: "budget-actual-variance",
    title: "Budget versus actuals",
    prompt: "Compare monthly budget and actual spend and show variance drivers.",
    dataNotes: ["Budget and actual are distinct measures; do not relabel either."],
    requiredFamilies: ["combined_bar_line", "waterfall"],
    requiredControls: ["scenario"],
    requiredActions: ["open-period"],
    expectedValues: [],
    policy: { currencies: ["USD"], maxSourceFiles: 7 },
  },
  {
    id: "sparse-operations",
    title: "Sparse operational data",
    prompt:
      "Build an operational trend where missing observations remain visibly missing while recorded zeros remain zero.",
    dataNotes: ["Null and zero are semantically different."],
    requiredFamilies: ["stacked_timeline"],
    requiredControls: ["metric"],
    requiredActions: [],
    expectedValues: [],
    policy: { preserveMissing: true, maxSourceFiles: 5 },
  },
  {
    id: "multi-currency-spend",
    title: "Multi-currency spend",
    prompt: "Show spend without silently consolidating USD and EUR values.",
    dataNotes: ["No FX policy is supplied; currency groups must remain separate."],
    requiredFamilies: ["breakdown", "stacked_timeline"],
    requiredControls: ["currency"],
    requiredActions: ["open-transactions"],
    expectedValues: [],
    policy: { currencies: ["USD", "EUR"], maxSourceFiles: 6 },
  },
  {
    id: "heatmap-coordinate-repair",
    title: "Heatmap coordinate repair",
    prompt:
      "Build a category-by-month heatmap and repair duplicate coordinate diagnostics if present.",
    dataNotes: ["Each row/column coordinate must be unique."],
    requiredFamilies: ["heatmap"],
    requiredControls: ["period"],
    requiredActions: ["filter-cell"],
    expectedValues: [],
    policy: { maxSourceFiles: 5 },
  },
  {
    id: "ambiguous-click-policy",
    title: "Ambiguous chart activation",
    prompt:
      "Build a vendor dashboard and choose an explicit, host-owned behavior for chart activation.",
    dataNotes: ["The chart component must not decide navigation or persistence."],
    requiredFamilies: ["breakdown", "scatter"],
    requiredControls: ["period"],
    requiredActions: ["open-vendor"],
    expectedValues: [],
    policy: { maxSourceFiles: 6 },
  },
  {
    id: "narrow-embedded-dashboard",
    title: "Narrow embedded dashboard",
    prompt:
      "Build a compact dashboard suitable for a narrow Sheet without bypassing public compositions.",
    dataNotes: ["Prefer bounded heights and existing responsive composition behavior."],
    requiredFamilies: ["donut", "range_marker"],
    requiredControls: ["period"],
    requiredActions: ["open-records"],
    expectedValues: [],
    policy: { maxSourceFiles: 5 },
  },
];

export function dashboardEvalCase(caseId: string) {
  return dashboardEvalCorpus.find((entry) => entry.id === caseId);
}
