// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vite-plus/test";

const enterprise = vi.hoisted(() => ({
  AllEnterpriseModule: { moduleName: "all-enterprise" },
  LicenseManager: { setLicenseKey: vi.fn() },
  ModuleRegistry: { registerModules: vi.fn() },
}));
vi.mock("ag-charts-enterprise", () => enterprise);
vi.mock("ag-charts-react", () => ({
  AgCharts: (props: { options: { title?: { text?: string } } }) => (
    <div data-testid="ag-charts">{props.options.title?.text}</div>
  ),
}));

import { AgChartsHost, bootstrapAgCharts } from "../charting/runtime";

it("registers the enterprise modules once before the first chart renders", async () => {
  bootstrapAgCharts({ licenseKey: "key-a" });
  const options = { title: { text: "Spread" } } as never;
  const { rerender } = render(<AgChartsHost options={options} label="spread" height={120} />);
  await waitFor(() => expect(screen.getByTestId("ag-charts")).toHaveTextContent("Spread"));
  rerender(<AgChartsHost options={options} label="spread" height={160} />);

  expect(enterprise.LicenseManager.setLicenseKey).toHaveBeenCalledWith("key-a");
  expect(enterprise.ModuleRegistry.registerModules).toHaveBeenCalledTimes(1);
  expect(enterprise.ModuleRegistry.registerModules).toHaveBeenCalledWith([
    enterprise.AllEnterpriseModule,
  ]);
});
