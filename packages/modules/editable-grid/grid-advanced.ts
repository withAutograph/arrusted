import { ModuleRegistry } from "ag-grid-community";
import { AllEnterpriseModule, LicenseManager } from "ag-grid-enterprise";

import { isAdvancedGridBootstrapped, markAdvancedGridBootstrapped } from "./grid-state";

export type AdvancedGridBootstrapOptions = {
  licenseKey?: string;
  allowMissingLicense?: boolean;
};

export function bootstrapAdvancedGrid(options: AdvancedGridBootstrapOptions = {}): void {
  if (isAdvancedGridBootstrapped()) return;
  const envKey =
    typeof process !== "undefined" ? process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY : undefined;
  const licenseKey = (options.licenseKey ?? envKey ?? "").trim();
  const isProduction = typeof process !== "undefined" && process.env.NODE_ENV === "production";

  if (!licenseKey) {
    if (isProduction || options.allowMissingLicense === false) {
      throw new Error(
        "AG Grid Enterprise license key is required for analytics='advanced' in production. " +
          "Set NEXT_PUBLIC_AG_GRID_LICENSE_KEY or switch EditableRowVersionGrid to analytics='basic'.",
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[arrusted/ui] NEXT_PUBLIC_AG_GRID_LICENSE_KEY is not set; running AG Grid Enterprise in local trial mode.",
    );
  }

  LicenseManager.setLicenseKey(licenseKey);
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  markAdvancedGridBootstrapped();
}
