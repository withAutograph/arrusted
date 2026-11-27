import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";

import { isBasicGridBootstrapped, markBasicGridBootstrapped } from "./grid-state";

export function bootstrapBasicGrid(): void {
  if (isBasicGridBootstrapped()) return;
  ModuleRegistry.registerModules([AllCommunityModule]);
  markBasicGridBootstrapped();
}
