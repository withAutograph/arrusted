import type { ModuleRegistry } from "ag-charts-community";

type Modules = Parameters<typeof ModuleRegistry.registerModules>[0];

/** The parts of `ag-charts-enterprise` this runtime needs. */
export type AgChartsEnterprise = {
  AllEnterpriseModule: Modules[number];
  LicenseManager: { setLicenseKey(key: string): void };
};

/**
 * AG Charts Community (MIT) is the default; heatmap, range-marker and waterfall
 * charts then show their data as a table. To use AG Charts Enterprise, buy a
 * licence, install `ag-charts-enterprise` at the same version as
 * `ag-charts-community`, and replace `null` with:
 *
 *   () => import("ag-charts-enterprise")
 *
 * See docs/ag-enterprise.md.
 */
export const loadAgChartsEnterprise: (() => Promise<AgChartsEnterprise>) | null = null;
