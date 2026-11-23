import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { chromium } from "playwright";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { expect, it } from "vitest";
import { IntegrationsSurface } from "../IntegrationsSurface";

it("fits desktop panels as their container resizes without horizontal overflow", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const themePath = path.resolve(testDir, "../../../design-systems/core/tokens/theme.css");
  const modulePath = path.resolve(testDir, "../integrations.css");
  const componentSource = path.resolve(testDir, "../../../design-systems/core/components");
  const moduleSource = path.resolve(testDir, "..");
  const theme = (await readFile(themePath, "utf8")).replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  );
  const css = await postcss([tailwindcss()]).process(
    `${theme}\n@source "${componentSource}";\n@source "${moduleSource}";\n${await readFile(modulePath, "utf8")}`,
    { from: themePath },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const html = renderToString(
      <IntegrationsSurface
        providers={Array.from({ length: 3 }, (_, index) => ({
          id: `provider-${index}`,
          name: `Provider ${index}`,
          description: "Accounting, customer records and planning data",
          status: { label: "Available", tone: "neutral" as const },
          connect: { kind: "connect" as const, availability: "available" as const },
        }))}
        accounts={[
          {
            id: "account",
            providerId: "provider-0",
            label: "A long organization account name that should wrap within the current panel",
            status: { label: "Connected", tone: "success" },
            activation: { label: "Active", tone: "success" },
            actions: [
              {
                kind: "disconnect",
                availability: "unavailable",
                reason: "Ask an organization administrator to disconnect this account.",
                impact: { summary: "Organization account", affectedApps: [] },
              },
            ],
          },
        ]}
        activity={[
          {
            id: "event",
            providerId: "provider-0",
            title: "Import completed",
            detail: "Long account activity details remain within the panel",
            occurredAt: "Today at 10:30",
          },
        ]}
      />,
    );
    await page.setContent(
      `<style>${css.css}</style><main id="panel" style="width:1100px;padding:16px">${html}</main>`,
    );
    for (const width of [1100, 760, 480, 920]) {
      await page.locator("#panel").evaluate((element, next) => {
        (element as HTMLElement).style.width = `${next}px`;
      }, width);
      const sizes = await page.locator(".integrations-surface").evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        text: getComputedStyle(element).color,
      }));
      expect(sizes.client).toBeGreaterThan(0);
      expect(sizes.scroll).toBeLessThanOrEqual(sizes.client + 1);
      expect(await page.getByRole("heading", { name: "Connected accounts" }).isVisible()).toBe(
        true,
      );
    }
  } finally {
    await browser.close();
  }
}, 30_000);
