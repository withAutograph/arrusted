# AG Grid and AG Charts Enterprise

arrusted installs only the MIT-licensed Community editions. Enterprise is
optional, commercially licensed by AG Grid Ltd, and never bundled by default.

| | Community (default) | Enterprise |
| --- | --- | --- |
| Grid | editing, sorting, text/number/date filters, row selection; the focused cell is what an agent sees as selected | adds row grouping, side panels, cell ranges, set filters, range copy and paste |
| Charts | bar, line, donut, scatter | adds heatmap, range marker and waterfall; Community shows those as tables |

## Turning Enterprise on

1. Buy the licence you need from AG Grid.
2. Install the package at the same version as its Community package in the root
   `package.json`, for example `bun add ag-grid-enterprise@33.3.0` or
   `bun add ag-charts-enterprise@14.1.0`.
3. Change `null` to the import shown in
   `packages/modules/editable-grid/enterprise.ts` or
   `packages/design-systems/core/compositions/charting/enterprise.ts`.
4. Set `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` or `NEXT_PUBLIC_AG_CHARTS_LICENSE_KEY`
   (both are visible in the browser, as AG Grid intends), then rebuild.

With a key but no installed package, the app logs a warning and stays on
Community.
