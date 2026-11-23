import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import reportFixture from "./fixtures/vendor-spend-overview/report.json";
import submissionFixture from "./fixtures/vendor-spend-overview/submission.json";
import type { DashboardEvalReport, DashboardEvalSubmission } from "./types";
import { validateChartSpec } from "../../packages/design-systems/core/compositions/Charts.validation";
import { ChartComposition } from "../../packages/design-systems/core/compositions/charting/ChartComposition";
import type {
  ChartConfig,
  ChartSegmentClick,
} from "../../packages/design-systems/core/compositions/charting/types";

const meta = {
  title: "Agent Evaluations/Dashboard Results",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const submission = submissionFixture as DashboardEvalSubmission;
const report = reportFixture as DashboardEvalReport;
const chartTitles: Record<string, { title: string; description: string }> = {
  "spend-mix": {
    title: "Approved spend by category",
    description: "Category mix for the selected reporting period.",
  },
  "spend-volume": {
    title: "Spend and transaction volume",
    description: "Net spend and transaction count by month.",
  },
  "category-month": {
    title: "Category spend by month",
    description: "Net spend intensity across categories and periods.",
  },
  "vendor-concentration": {
    title: "Vendor concentration",
    description: "Transaction volume plotted against net spend.",
  },
};

export const CanonicalVendorSubmission: Story = {
  render: () => <DashboardEvalResults submission={submission} report={report} />,
};

export const CanonicalVendorNarrow: Story = {
  render: () => (
    <DashboardEvalResults submission={submission} report={report} initialViewport="narrow" />
  ),
};

function DashboardEvalResults(props: {
  submission: DashboardEvalSubmission;
  report: DashboardEvalReport;
  initialViewport?: "desktop" | "narrow";
}) {
  const [viewport, setViewport] = useState<"desktop" | "narrow">(
    props.initialViewport ?? "desktop",
  );
  const [tab, setTab] = useState<"preview" | "evidence" | "spec">("preview");
  const [controlValues, setControlValues] = useState<Record<string, string>>({});
  const [lastEvent, setLastEvent] = useState("No chart interaction yet");
  const validatedCharts = useMemo(
    () =>
      props.submission.charts.map((chart) => ({
        ...chart,
        config: validateChartSpec(chart.config),
      })),
    [props.submission],
  );

  return (
    <main className="min-h-screen bg-[var(--color-bg-page)] font-[var(--font-sans)] text-[var(--color-text-primary)]">
      <header className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-6)] py-[var(--space-5)]">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-start justify-between gap-[var(--space-4)]">
          <div>
            <div className="mb-[var(--space-2)] flex items-center gap-[var(--space-2)] text-[length:var(--text-caption)] font-[var(--font-weight-medium)] text-[var(--color-text-muted)]">
              <span>Agent evaluation</span>
              <span aria-hidden="true">/</span>
              <span>{props.report.caseId}</span>
            </div>
            <h1 className="text-[length:var(--text-page-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-page-title)] tracking-[var(--tracking-tight)]">
              Vendor analytics dashboard
            </h1>
            <p className="mt-[var(--space-1)] text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-secondary)]">
              The exact agent submission rendered through the production chart contract.
            </p>
          </div>
          <ScoreSummary report={props.report} />
        </div>
      </header>
      <div className="mx-auto max-w-[1440px] px-[var(--space-6)] py-[var(--space-5)]">
        <div className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)]">
          <nav
            aria-label="Evaluation result sections"
            className="flex rounded-[var(--radius-control)] bg-[var(--color-bg-muted)] p-[var(--space-1)]"
          >
            {(["preview", "evidence", "spec"] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
                className={`rounded-[var(--radius-xs)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-control-sm)] font-[var(--font-weight-medium)] capitalize ${tab === item ? "bg-[var(--color-bg-surface)] shadow-[var(--shadow-subtle)]" : "text-[var(--color-text-secondary)]"}`}
              >
                {item === "spec" ? "Chart specs" : item}
              </button>
            ))}
          </nav>
          {tab === "preview" ? (
            <div className="flex items-center gap-[var(--space-3)]">
              <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                Viewport
              </span>
              <div className="flex rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-1)]">
                {(["desktop", "narrow"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={viewport === item}
                    onClick={() => setViewport(item)}
                    className={`rounded-[var(--radius-xs)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-control-xs)] capitalize ${viewport === item ? "bg-[var(--color-bg-selected)] text-[var(--color-action-primary-ink)]" : "text-[var(--color-text-secondary)]"}`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {tab === "preview" ? (
          <section
            aria-label="Rendered dashboard preview"
            className="overflow-auto rounded-[var(--radius-card-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-muted)] p-[var(--space-4)]"
          >
            <div
              className={`mx-auto transition-[max-width] ${viewport === "narrow" ? "max-w-[420px]" : "max-w-none"}`}
            >
              <div className="rounded-[var(--radius-shell)] bg-[var(--color-bg-page)] p-[var(--space-4)] shadow-[var(--shadow-card-soft)]">
                <div className="mb-[var(--space-4)] flex flex-wrap items-end justify-between gap-[var(--space-3)]">
                  <div>
                    <div className="text-[length:var(--text-caption)] font-[var(--font-weight-medium)] text-[var(--color-text-muted)]">
                      Procurement
                    </div>
                    <h2 className="text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-section-title)]">
                      Vendor overview
                    </h2>
                  </div>
                  <div
                    aria-live="polite"
                    className="rounded-[var(--radius-pill)] bg-[var(--color-bg-accent-soft)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-action-primary-ink)]"
                  >
                    {lastEvent}
                  </div>
                </div>
                <div
                  className={`grid gap-[var(--space-4)] ${viewport === "desktop" ? "lg:grid-cols-2" : "grid-cols-1"}`}
                >
                  {validatedCharts.map((chart) => (
                    <ChartComposition
                      key={chart.id}
                      spec={{
                        type: "chart",
                        ...chartTitles[chart.id],
                        config: withControlValues(chart.config, controlValues),
                      }}
                      onControlChange={(controlId, value) => {
                        setControlValues((current) => ({ ...current, [controlId]: value }));
                        setLastEvent(`${controlId} changed to ${value}`);
                      }}
                      onSegmentClick={(segment) =>
                        setLastEvent(describeSegment("Selected", segment))
                      }
                      onSegmentAction={(actionId, segment) =>
                        setLastEvent(
                          describeSegment(actionLabel(props.submission, actionId), segment),
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : null}
        {tab === "evidence" ? (
          <EvidencePanel report={props.report} submission={props.submission} />
        ) : null}
        {tab === "spec" ? <SpecPanel submission={props.submission} /> : null}
      </div>
    </main>
  );
}

function ScoreSummary({ report }: { report: DashboardEvalReport }) {
  return (
    <div className="flex items-center gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-page)] px-[var(--space-4)] py-[var(--space-3)]">
      <div className="flex size-[48px] items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-status-success-bg)] text-[length:var(--text-title)] font-[var(--font-weight-semibold)] text-[var(--color-status-success-ink)]">
        {report.score}
      </div>
      <div>
        <div className="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] text-[var(--color-status-success-ink)]">
          {report.passed ? "PASS" : "FAIL"}
        </div>
        <div className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {report.checks.filter((check) => check.passed).length}/{report.checks.length} checks ·{" "}
          {report.maximumScore} points possible
        </div>
      </div>
    </div>
  );
}

function EvidencePanel({
  report,
  submission,
}: {
  report: DashboardEvalReport;
  submission: DashboardEvalSubmission;
}) {
  return (
    <div className="grid gap-[var(--space-4)] xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className="rounded-[var(--radius-card-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-5)]">
        <h2 className="text-[length:var(--text-title)] font-[var(--font-weight-semibold)]">
          Scoring evidence
        </h2>
        <div className="mt-[var(--space-4)] divide-y divide-[var(--color-border-subtle)]">
          {report.checks.map((check) => (
            <div
              key={check.id}
              className="flex items-start gap-[var(--space-3)] py-[var(--space-3)]"
            >
              <span
                className={`mt-[var(--space-0-5)] flex size-[24px] shrink-0 items-center justify-center rounded-[var(--radius-pill)] text-[length:var(--text-caption)] ${check.passed ? "bg-[var(--color-status-success-bg)] text-[var(--color-status-success-ink)]" : "bg-[var(--color-status-danger-bg)] text-[var(--color-status-danger-ink)]"}`}
              >
                {check.passed ? "✓" : "×"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[length:var(--text-body)] font-[var(--font-weight-medium)]">
                  {check.label}
                </div>
                {check.detail ? (
                  <div className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
                    {check.detail}
                  </div>
                ) : null}
              </div>
              <div className="text-[length:var(--text-caption)] font-[var(--font-weight-semibold)]">
                {check.earned}/{check.points}
              </div>
            </div>
          ))}
        </div>
      </section>
      <aside className="grid content-start gap-[var(--space-4)]">
        <Metric label="Validated charts" value={String(report.summary.validChartCount)} />
        <Metric label="Source files" value={String(report.summary.sourceFileCount)} />
        <Metric label="Repair attempts" value={String(report.summary.repairAttempts)} />
        <Metric
          label="Generation time"
          value={
            submission.elapsedMs ? `${Math.round(submission.elapsedMs / 1000)}s` : "Not recorded"
          }
        />
      </aside>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-4)]">
      <div className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-[var(--space-1)] text-[length:var(--text-section-title)] font-[var(--font-weight-semibold)]">
        {value}
      </div>
    </div>
  );
}
function SpecPanel({ submission }: { submission: DashboardEvalSubmission }) {
  return (
    <section className="rounded-[var(--radius-card-lg)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] p-[var(--space-5)]">
      <h2 className="text-[length:var(--text-title)] font-[var(--font-weight-semibold)]">
        Submitted chart contracts
      </h2>
      <p className="mt-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        These serializable configs are both evaluated and rendered above.
      </p>
      <div className="mt-[var(--space-4)] grid gap-[var(--space-3)]">
        {submission.charts.map((chart) => (
          <details
            key={chart.id}
            className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-page)] p-[var(--space-3)]"
          >
            <summary className="cursor-pointer text-[length:var(--text-body)] font-[var(--font-weight-medium)]">
              {chart.id}{" "}
              <span className="ml-[var(--space-2)] text-[length:var(--text-caption)] font-[var(--font-weight-normal)] text-[var(--color-text-muted)]">
                {(chart.config as { family?: string }).family}
              </span>
            </summary>
            <pre className="mt-[var(--space-3)] overflow-auto rounded-[var(--radius-control)] bg-[var(--color-bg-subtle)] p-[var(--space-3)] font-[var(--font-mono)] text-[length:var(--text-micro)] leading-[var(--leading-micro)] text-[var(--color-text-secondary)]">
              {JSON.stringify(chart.config, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </section>
  );
}
function withControlValues(config: ChartConfig, values: Record<string, string>): ChartConfig {
  if (!("controls" in config) || !config.controls) return config;
  return {
    ...config,
    controls: config.controls.map((control) => ({
      ...control,
      value: values[control.id] ?? control.value,
    })),
  } as ChartConfig;
}
function describeSegment(prefix: string, segment: ChartSegmentClick) {
  return `${prefix}: ${segment.datumId}`;
}
function actionLabel(submission: DashboardEvalSubmission, actionId: string) {
  const behavior = submission.actionBindings.find(
    (binding) => binding.actionId === actionId,
  )?.behavior;
  return behavior ? behavior.replace("_", " ") : actionId;
}
