import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import type { AgChartOptions } from "ag-charts-community";
import type { AgCharts as AgChartsComponent } from "ag-charts-react";
import { loadAgChartsEnterprise } from "./enterprise";

export type AgChartsBootstrapOptions = { licenseKey?: string };

let licenseKey: string | undefined;
let modulesPromise: Promise<void> | undefined;

/**
 * Sets the optional Enterprise licence key. Without one, charts use AG Charts
 * Community. Call it before the first chart renders.
 */
export function bootstrapAgCharts(options: AgChartsBootstrapOptions = {}) {
  const key = options.licenseKey?.trim() || undefined;
  if (key !== licenseKey && modulesPromise !== undefined)
    throw new Error("AG Charts has already been bootstrapped with different options");
  licenseKey = key;
  if (key !== undefined && loadAgChartsEnterprise === null)
    console.warn(
      "[charts] An AG Charts licence key is set but Enterprise is not enabled; see docs/ag-enterprise.md.",
    );
}

/** Whether heatmap, range-marker and waterfall charts can be drawn. */
export function agChartsEnterpriseEnabled(): boolean {
  return licenseKey !== undefined && loadAgChartsEnterprise !== null;
}

async function registerModules() {
  const { AllCommunityModule, ModuleRegistry } = await import("ag-charts-community");
  ModuleRegistry.registerModules([AllCommunityModule]);
  if (licenseKey !== undefined && loadAgChartsEnterprise !== null) {
    const enterprise = await loadAgChartsEnterprise();
    enterprise.LicenseManager.setLicenseKey(licenseKey);
    ModuleRegistry.registerModules([enterprise.AllEnterpriseModule]);
  }
}

type LazyAgChartsType = typeof AgChartsComponent;

const LazyAgCharts = lazy(async () => {
  await (modulesPromise ??= registerModules());
  const charts = await import("ag-charts-react");
  return { default: charts.AgCharts as LazyAgChartsType };
}) as unknown as LazyAgChartsType;

export function AgChartsHost(props: { options: AgChartOptions; label: string; height: number }) {
  return (
    <ChartErrorBoundary>
      <div aria-hidden="true" style={{ height: props.height, minWidth: 0, width: "100%" }}>
        <Suspense fallback={<ChartLoading label={props.label} height={props.height} />}>
          <LazyAgCharts options={props.options} style={{ height: "100%", width: "100%" }} />
        </Suspense>
      </div>
    </ChartErrorBoundary>
  );
}

function ChartLoading(props: { label: string; height: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[var(--radius-panel)] bg-[var(--color-bg-skeleton)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
      style={{ height: props.height }}
    >
      Loading {props.label}…
    </div>
  );
}

class ChartErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[charts] Failed to render chart", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className="rounded-[var(--radius-panel)] bg-[var(--color-bg-muted)] p-[var(--space-4)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
        >
          Chart unavailable: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export type { AgCartesianChartOptions, AgChartOptions } from "ag-charts-community";
