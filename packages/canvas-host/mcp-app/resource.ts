// The canvas resource as the MCP route serves it (server side): the built
// single-file document with its config injected at read time, and the
// `_meta.ui` the host needs (CSP connect domains, Claude's frame domain).
import type { DataDefinition } from "@autograph/generated-app-runtime/data";

import { CANVAS_CONFIG_ELEMENT_ID, type CanvasFrameConfig } from "./config";

export type { CanvasFrameConfig } from "./config";

/** The canvas's MCP Apps resource. */
export const CANVAS_RESOURCE_URI = "ui://autograph/canvas";
export const CANVAS_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
/** The static public client the frame signs in as. */
export const CANVAS_FRAME_CLIENT_ID = "autograph-canvas";

/** What an app tells the host about serving its canvas in a chat. */
export type CanvasChat = {
  /** The exact public origin the app, its MCP route and the realm share. */
  publicOrigin: string;
  /** The app as people name it, e.g. "Comp canvas". */
  title: string;
  /** Claude's frame domain for this app's exact MCP endpoint. */
  claudeDomain: string;
  /**
   * The built `dist/mcp-app.html`, or null when this deployment has none:
   * the MCP route then offers no view (no resource, no `resourceUri`) and
   * `open_canvas` answers in text only.
   */
  html(): Promise<string | null>;
  agGridLicenseKey: string | null;
  agChartsLicenseKey: string | null;
  moneyDefaults?: Readonly<Record<string, string>>;
};

/** The frame's config for one app, from its public origin. */
export function canvasFrameConfig(
  chat: CanvasChat,
  app: { appId: string; definition: DataDefinition },
): CanvasFrameConfig {
  const origin = new URL(chat.publicOrigin).origin;
  const canvasUrl = `${origin}/${app.appId}/api/canvas`;
  return {
    appId: app.appId,
    title: chat.title,
    canvasUrl,
    resource: canvasUrl,
    deviceEndpoint: `${origin}/api/auth/device/code`,
    tokenEndpoint: `${origin}/api/auth/oauth2/token`,
    clientId: CANVAS_FRAME_CLIENT_ID,
    webUrl: `${origin}/${app.appId}`,
    definition: app.definition,
    ...(chat.moneyDefaults === undefined ? {} : { moneyDefaults: chat.moneyDefaults }),
    agGridLicenseKey: chat.agGridLicenseKey,
    agChartsLicenseKey: chat.agChartsLicenseKey,
  };
}

/** The document with its config in a JSON script element (never executable, never closing early). */
export function injectFrameConfig(html: string, config: CanvasFrameConfig): string {
  const json = JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
  const element = `<script type="application/json" id="${CANVAS_CONFIG_ELEMENT_ID}">${json}</script>`;
  if (!html.includes("</head>")) throw new Error("The canvas document has no head");
  return html.replace("</head>", `${element}</head>`);
}

/** The `resources/read` contents of the canvas for one app, from its built document. */
export function canvasResourceContents(
  chat: CanvasChat,
  app: { appId: string; definition: DataDefinition },
  html: string,
) {
  const origin = new URL(chat.publicOrigin).origin;
  return {
    uri: CANVAS_RESOURCE_URI,
    mimeType: CANVAS_RESOURCE_MIME_TYPE,
    text: injectFrameConfig(html, canvasFrameConfig(chat, app)),
    _meta: {
      ui: {
        // The frame reaches the app's public origin only (API, device, token).
        csp: { connectDomains: [origin] },
        // Claude's stable frame origin for this connector, which the realm's
        // CORS and trusted origins allow.
        domain: chat.claudeDomain,
        prefersBorder: false,
      },
    },
  };
}
