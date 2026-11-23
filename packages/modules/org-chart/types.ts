// Org-chart shared types. The module is generic over the slot/occupant join;
// apps own the domain-specific mapping and payload contents.
export type OrgChartAtom = Record<string, unknown>;

/**
 * Discriminator for different types of nodes in the org chart.
 *
 * The canvas treats all three uniformly for layout; only the host's
 * renderNode adapter cares about the kind.
 */
export type OrgChartNodeKind = "subject" | "vacant" | "external";

/**
 * Per-card field shape carried through for the host renderer. The canvas does
 * not render these fields directly.
 */
export type DynamicFieldValue = {
  fieldName: string;
  label: string;
  value: string;
  isLookup?: boolean;
};

/**
 * Options passed to a node's activate callback. Meta/ctrl sets `append` for
 * host-owned multi-select behavior.
 */
export type NodeActivateOptions = {
  append: boolean;
};

/**
 * Payload emitted by the canvas when a node activates. Hosts use this to drive
 * selection, focus, or routing.
 */
export type OrgChartNodeActivatePayload = {
  nodeId: string;
  subjectId: string | null;
  slotId: string | null;
  nodeKind: OrgChartNodeKind;
  isVirtualRoot: boolean;
  append: boolean;
};
