// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vite-plus/test";

import { AgChartsHost, bootstrapAgCharts } from "../charting/runtime";

// Real AG Charts through the composition runtime, no mocks. AG Charts refuses
// to create any chart until modules are registered ("AG Charts - No modules
// have been registered"), which the chart's error boundary would show; the
// runtime registers them before the first chart renders.
it("renders a real chart without AG Charts' missing-module error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  bootstrapAgCharts();
  render(
    <AgChartsHost
      label="spread"
      height={120}
      options={{
        data: [{ x: "a", y: 1 }],
        series: [{ type: "bar", xKey: "x", yKey: "y" }],
      }}
    />,
  );
  // The lazy runtime has loaded once the loading placeholder is gone.
  await waitFor(() => expect(screen.queryByText("Loading spread…")).toBeNull(), {
    timeout: 30_000,
  });
  // jsdom has no canvas, so a later step may still fail; never for missing modules.
  expect(screen.queryByRole("alert")?.textContent ?? "").not.toMatch(
    /No modules have been registered/u,
  );
});
