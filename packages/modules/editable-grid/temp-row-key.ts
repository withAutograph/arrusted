// Shared temp row-key contract for create previews staged through the
// editable-grid module. Client-only row keys are never sent as record_key.

export const EDITABLE_GRID_TEMP_ROW_KEY_PREFIX = "tmp:";

export function isEditableGridTempRowKey(rowKey: string): boolean {
  return rowKey.startsWith(EDITABLE_GRID_TEMP_ROW_KEY_PREFIX);
}
