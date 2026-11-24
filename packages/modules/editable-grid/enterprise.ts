import type { Module } from "ag-grid-community";

/** The parts of `ag-grid-enterprise` this module needs. */
export type AgGridEnterprise = {
  AllEnterpriseModule: Module;
  LicenseManager: { setLicenseKey(key: string): void };
};

/**
 * AG Grid Community (MIT) is the default. To use AG Grid Enterprise, buy a
 * licence, install `ag-grid-enterprise` at the same version as
 * `ag-grid-community`, and replace `null` with:
 *
 *   () => import("ag-grid-enterprise")
 *
 * See docs/ag-enterprise.md.
 */
export const loadAgGridEnterprise: (() => Promise<AgGridEnterprise>) | null = null;
