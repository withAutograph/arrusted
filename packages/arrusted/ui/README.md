# `@arrusted/ui`

Design-system primitives, temporal record hooks, and tiered `EditableRowVersionGrid` (`analytics="basic" | "advanced"`) for Arrusted applications.

## Grid Analytics Tiers

`EditableRowVersionGrid` requires an explicit `analytics` prop (`"basic"` or `"advanced"`):

- **`analytics="basic"` (AG Grid Community, MIT):** Call `bootstrapBasicGrid()` from `@arrusted/ui` (or `@arrusted/ui/grid-basic`). No license key or `ag-grid-enterprise` peer package is required.
- **`analytics="advanced"` (AG Grid Enterprise):** Install peer dependency `ag-grid-enterprise` and call `bootstrapAdvancedGrid()` from `@arrusted/ui/grid-advanced`. Production builds (`NODE_ENV=production`) require a license key via `NEXT_PUBLIC_AG_GRID_LICENSE_KEY` or `bootstrapAdvancedGrid({ licenseKey })` and fail closed if neither is supplied.
