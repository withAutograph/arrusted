import type { VisibleRecord } from "@contracts";

import type { MetaRowMarker } from "./row-meta-row";

export function isMetaRow(
  row: VisibleRecord | MetaRowMarker | undefined | null,
): row is MetaRowMarker {
  return !!row && (row as MetaRowMarker).__metaRow === true;
}
