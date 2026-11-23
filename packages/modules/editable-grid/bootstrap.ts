// AG Grid bootstrap — license + Enterprise module registration.
//
// Apps call this ONCE at React root mount time (before any
// `<EditableRowVersionGrid>` renders). Encapsulating it here means apps
// never directly import `ag-grid-*`, which keeps the scanner rule
// (apps cannot import ag-grid-* directly) airtight: license / module
// setup is library territory, not app territory.

import { LicenseManager } from "ag-grid-enterprise";
import { ModuleRegistry } from "ag-grid-community";
import { AllEnterpriseModule } from "ag-grid-enterprise";

let bootstrapped = false;

export function bootstrapAgGrid(options: {
  licenseKey?: string;
  allowMissingLicense?: boolean;
}): void {
  if (bootstrapped) return;
  const licenseKey = options.licenseKey?.trim();
  if (!licenseKey) {
    if (!options.allowMissingLicense) {
      throw new Error(
        "AG Grid Enterprise license key is missing. Pass VITE_AG_GRID_LICENSE_KEY " +
          "or explicitly allow missing licenses for a trial-mode environment.",
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[editable-grid] AG Grid Enterprise license key is missing; continuing because allowMissingLicense was explicitly set.",
    );
  }
  LicenseManager.setLicenseKey(licenseKey ?? "");
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  bootstrapped = true;
}
