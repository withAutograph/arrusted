import { render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { resetGridBootstrapForTesting } from "../../../modules/editable-grid/grid-state";
import { bootstrapAdvancedGrid } from "../src/grid-advanced";
import {
  bootstrapBasicGrid,
  EditableRowVersionGrid,
  type EditableRowVersionGridProps,
} from "../src/index";

function minimalSurfaceProps(): Omit<EditableRowVersionGridProps, "analytics"> {
  return {
    mode: "edit",
    rows: [],
    columnDefs: [],
    onGridReady: () => {},
    isFullWidthRow: () => false,
    fullWidthCellRendererParams: {
      onDiscardRow: () => {},
      setRowEffectiveDate: () => {},
      setRowChangeType: () => {},
      onClickBulkLink: () => {},
      bulkGroupLabel: () => "",
      changeTypeLabel: () => "",
      changeTypeOptions: [],
      bulkFilterActive: false,
    },
    getRowHeight: () => undefined,
    externalFilterPresent: false,
    externalFilterPass: () => true,
    filterVersion: 0,
  };
}

afterEach(() => {
  resetGridBootstrapForTesting();
  vi.unstubAllEnvs();
});

describe("@arrusted/ui analytics tier enforcement", () => {
  test("throws when analytics prop is omitted or not bootstrapped", () => {
    expect(() =>
      render(
        <EditableRowVersionGrid
          {...(minimalSurfaceProps() as unknown as EditableRowVersionGridProps)}
        />,
      ),
    ).toThrow(/requires an explicit analytics='basic' \| 'advanced' prop/);

    expect(() =>
      render(<EditableRowVersionGrid analytics="basic" {...minimalSurfaceProps()} />),
    ).toThrow(/requires bootstrapBasicGrid/);

    bootstrapBasicGrid();
    expect(() =>
      render(<EditableRowVersionGrid analytics="advanced" {...minimalSurfaceProps()} />),
    ).toThrow(/requires bootstrapAdvancedGrid/);
  });

  test("renders Community grid cleanly under analytics='basic' after bootstrapBasicGrid()", () => {
    bootstrapBasicGrid();
    const { container } = render(
      <EditableRowVersionGrid analytics="basic" {...minimalSurfaceProps()} />,
    );
    const root = container.querySelector('[data-grid="editable-row-version"]');
    expect(root).not.toBeNull();
    expect(root?.getAttribute("data-grid-analytics")).toBe("basic");
  });

  test("bootstrapAdvancedGrid fails closed in production without NEXT_PUBLIC_AG_GRID_LICENSE_KEY", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "");
    expect(() => bootstrapAdvancedGrid()).toThrow(
      /AG Grid Enterprise license key is required for analytics='advanced' in production/,
    );
  });

  test("bootstrapAdvancedGrid allows local trial mode and unlocks analytics='advanced'", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_AG_GRID_LICENSE_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    bootstrapAdvancedGrid();
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();

    const { container } = render(
      <EditableRowVersionGrid analytics="advanced" {...minimalSurfaceProps()} />,
    );
    expect(container.querySelector('[data-grid="editable-row-version"]')).not.toBeNull();
  });
});
