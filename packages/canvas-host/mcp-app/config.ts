// What the host injects into the canvas resource at read time. Nothing here is
// a secret: the model can read the resource (the AG Grid key is public).
import type { DataDefinition } from "@autograph/generated-app-runtime/data";

/** The element the injected config is read from. */
export const CANVAS_CONFIG_ELEMENT_ID = "autograph-canvas-config";

export type CanvasFrameConfig = {
  appId: string;
  /** The app as people name it, e.g. "Comp canvas". */
  title: string;
  /** The canvas API, `<public origin>/<mount>/api/canvas` (also the token's resource). */
  canvasUrl: string;
  /** The canvas resource identifier the device sign-in asks for. */
  resource: string;
  /** The realm's device authorization and token endpoints. */
  deviceEndpoint: string;
  tokenEndpoint: string;
  /** The static canvas client. */
  clientId: string;
  /** The app's web canvas, `<public origin>/<mount>`. */
  webUrl: string;
  definition: DataDefinition;
  moneyDefaults?: Readonly<Record<string, string>>;
  agGridLicenseKey: string | null;
  agChartsLicenseKey: string | null;
};

/** The config this document was served with, or null outside a served resource. */
export function readFrameConfig(document: Document): CanvasFrameConfig | null {
  const element = document.getElementById(CANVAS_CONFIG_ELEMENT_ID);
  if (element === null) return null;
  try {
    return JSON.parse(element.textContent ?? "") as CanvasFrameConfig;
  } catch {
    return null;
  }
}
