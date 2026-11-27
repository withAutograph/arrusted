let basicBootstrapped = false;
let advancedBootstrapped = false;

export function markBasicGridBootstrapped(): void {
  basicBootstrapped = true;
}

export function markAdvancedGridBootstrapped(): void {
  advancedBootstrapped = true;
}

export function isBasicGridBootstrapped(): boolean {
  return basicBootstrapped;
}

export function isAdvancedGridBootstrapped(): boolean {
  return advancedBootstrapped;
}

export function resetGridBootstrapForTesting(): void {
  basicBootstrapped = false;
  advancedBootstrapped = false;
}
