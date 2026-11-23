import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import type { AgChartOptions } from "ag-charts-community";
import type { AgCharts as AgChartsComponent } from "ag-charts-react";

export type AgChartsBootstrapOptions = {
  licenseKey?: string;
  allowMissingLicense?: boolean;
};

let bootstrapOptions: AgChartsBootstrapOptions | undefined;
let enterprisePromise: Promise<void> | undefined;

export function bootstrapAgCharts(options: AgChartsBootstrapOptions) {
  if (bootstrapOptions) {
    const changed =
      bootstrapOptions.licenseKey !== options.licenseKey ||
      bootstrapOptions.allowMissingLicense !== options.allowMissingLicense;
    if (changed) throw new Error("AG Charts has already been bootstrapped with different options");
    return;
  }
  if (!options.licenseKey && !options.allowMissingLicense) {
    throw new Error(
      "AG Charts Enterprise license key is missing. Pass a license key or explicitly allow a missing key for non-production proof environments.",
    );
  }
  bootstrapOptions = { ...options };
}

async function ensureEnterprise() {
  if (!bootstrapOptions) {
    throw new Error("Call bootstrapAgCharts before rendering a chart");
  }
  enterprisePromise ??= import("ag-charts-enterprise").then((enterprise) => {
    if (bootstrapOptions?.licenseKey) {
      enterprise.LicenseManager.setLicenseKey(bootstrapOptions.licenseKey);
    }
    // AG Charts renders nothing until its series, axes and features are
    // registered; the compositions use the whole enterprise set.
    enterprise.ModuleRegistry.registerModules([enterprise.AllEnterpriseModule]);
  });
  return enterprisePromise;
}

type LazyAgChartsType = typeof AgChartsComponent;

const LazyAgCharts = lazy(async () => {
  await ensureEnterprise();
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
