// AG Grid bootstrap: module registration and the optional Enterprise licence.
//
// Apps call this ONCE before any `<EditableRowVersionGrid>` renders. Keeping it
// here means apps never import `ag-grid-*` directly (the scanner enforces it).

import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import { loadAgGridEnterprise } from "./enterprise";

let communityRegistered = false;
let enterprise: Promise<void> | undefined;
let enterpriseEnabled = false;

/** Whether Enterprise features (grouping, side bar, cell ranges) are available. */
export function agGridEnterpriseEnabled(): boolean {
  return enterpriseEnabled;
}

/**
 * Registers AG Grid Community synchronously. With a licence key and an installed
 * Enterprise package (see `enterprise.ts`) it also loads Enterprise; await the
 * result before rendering a grid in that case.
 */
export async function bootstrapAgGrid(options: { licenseKey?: string } = {}): Promise<void> {
  if (!communityRegistered) {
    ModuleRegistry.registerModules([AllCommunityModule]);
    communityRegistered = true;
  }
  const licenseKey = options.licenseKey?.trim();
  if (!licenseKey) return;
  if (loadAgGridEnterprise === null) {
    console.warn(
      "[editable-grid] An AG Grid licence key is set but Enterprise is not enabled; see docs/ag-enterprise.md.",
    );
    return;
  }
  enterprise ??= Promise.resolve()
    .then(loadAgGridEnterprise)
    .then(({ AllEnterpriseModule, LicenseManager }) => {
      LicenseManager.setLicenseKey(licenseKey);
      ModuleRegistry.registerModules([AllEnterpriseModule]);
      enterpriseEnabled = true;
    })
    .catch((error: unknown) => {
      console.error("[editable-grid] Enterprise failed to load; using Community.", error);
    });
  return enterprise;
}
