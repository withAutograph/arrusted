// The canvas resource as the MCP route serves it: the MCP Apps MIME type, the
// config injected as inert JSON, the app's public origin as the only connect
// domain, and Claude's frame domain derived from the exact MCP endpoint.
import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import { claudeFrameDomain } from "@autograph/auth/canvas-frame";

import {
  CANVAS_RESOURCE_MIME_TYPE,
  CANVAS_RESOURCE_URI,
  canvasResourceContents,
  injectFrameConfig,
} from "../mcp-app/resource";

const definition = {
  formatVersion: 1,
  schemaVersion: "v1",
  models: [],
} as unknown as DataDefinition;
const origin = "https://apps.example.test";

describe("canvas resource", () => {
  test("carries the MIME type, the config and the frame facts", async () => {
    const contents = await canvasResourceContents(
      {
        publicOrigin: `${origin}/`,
        title: "Comp canvas",
        claudeDomain: claudeFrameDomain(`${origin}/comp-canvas/api/mcp`),
        html: async () => null,
        agGridLicenseKey: "grid-key",
        agChartsLicenseKey: null,
      },
      { appId: "comp-canvas", definition },
      "<!doctype html><html><head><title>x</title></head><body></body></html>",
    );
    expect(contents.uri).toBe(CANVAS_RESOURCE_URI);
    expect(contents.mimeType).toBe(CANVAS_RESOURCE_MIME_TYPE);
    expect(contents._meta.ui.csp.connectDomains).toEqual([origin]);
    const hash = createHash("sha256")
      .update(`${origin}/comp-canvas/api/mcp`)
      .digest("hex")
      .slice(0, 32);
    expect(contents._meta.ui.domain).toBe(`${hash}.claudemcpcontent.com`);
    const config = JSON.parse(
      /<script type="application\/json" id="autograph-canvas-config">(.*)<\/script><\/head>/u.exec(
        contents.text,
      )![1]!,
    );
    expect(config).toMatchObject({
      appId: "comp-canvas",
      canvasUrl: `${origin}/comp-canvas/api/canvas`,
      resource: `${origin}/comp-canvas/api/canvas`,
      deviceEndpoint: `${origin}/api/auth/device/code`,
      tokenEndpoint: `${origin}/api/auth/oauth2/token`,
      clientId: "autograph-canvas",
      agGridLicenseKey: "grid-key",
    });
  });

  test("the injected config never closes its script early", () => {
    const html = injectFrameConfig("<html><head></head></html>", {
      title: "</script><script>alert(1)</script>",
    } as never);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    expect(html).toContain("\\u003c/script\\u003e");
  });
});
