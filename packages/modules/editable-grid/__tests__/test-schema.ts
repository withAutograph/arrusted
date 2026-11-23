import type { ColDef } from "ag-grid-community";

import type { Schema, VisibleRecord } from "@contracts";

import type { EditableRowVersionGridSurfaceProps } from "../index";

export const TEST_SCHEMA: Schema = {
  app_id: "hc",
  customer_id: "demo",
  version: "v1",
  change_types: [],
  models: [
    {
      id: "position",
      kind: "entity",
      label: "Position",
      fields: [
        { id: "title", label: "Title", type: "text", required: false },
        { id: "level", label: "Level", type: "text", required: false },
        { id: "is_open", label: "Open", type: "bool", required: false },
        { id: "start_date", label: "Start Date", type: "date", required: false },
        { id: "end_date", label: "End Date", type: "date", required: false },
      ],
    },
  ],
};

export function testSchemaConfig() {
  return { schema: TEST_SCHEMA, model: "position" } as const;
}

export function fieldSetterFromSurface(surfaceProps: EditableRowVersionGridSurfaceProps) {
  return ((fieldId: string) => {
    const col = surfaceProps.columnDefs.find((candidate) => candidate.colId === fieldId);
    if (!col?.valueSetter) {
      throw new Error(`No valueSetter for test field ${fieldId}`);
    }
    return col.valueSetter as NonNullable<ColDef<VisibleRecord>["valueSetter"]>;
  }) as never;
}

export function invalidRuleFromSurface(surfaceProps: EditableRowVersionGridSurfaceProps) {
  const firstWithRule = surfaceProps.columnDefs.find(
    (col) => col.cellClassRules && "ag-cell-invalid" in col.cellClassRules,
  );
  return firstWithRule?.cellClassRules?.["ag-cell-invalid"] as
    | ((params: { data?: VisibleRecord; colDef: ColDef }) => boolean)
    | undefined;
}
