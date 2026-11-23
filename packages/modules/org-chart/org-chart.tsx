import "./org-chart.css";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { Button, TextField } from "@autograph/components";

import { OrgChartCanvas } from "./canvas";
import type {
  ChartInstanceHandle,
  ChartRenderNodeFn,
  OrgChartCanvasProps,
  OrgChartData,
} from "./canvas";
import type { OrgChartNode } from "./layout";
import type { OrgChartNodeActivatePayload } from "./types";

export type OrgChartSearchText = ReadonlyMap<string, string> | ((node: OrgChartNode) => string);

export type OrgChartProps = {
  data: OrgChartData;
  renderNode: ChartRenderNodeFn;
  asOfDate: string;
  searchText?: OrgChartSearchText;
  searchPlaceholder?: string;
  searchLabel?: string;
  visibleFields?: string[];
  showSlots?: boolean;
  slotMap?: OrgChartCanvasProps["slotMap"];
  focusNodeIds?: OrgChartCanvasProps["focusNodeIds"];
  focusedNodeIds?: OrgChartCanvasProps["focusedNodeIds"];
  onFocusConsumed?: OrgChartCanvasProps["onFocusConsumed"];
  className?: string;
  onNodeActivate?: OrgChartCanvasProps["onNodeActivate"];
  // Rendered on the leading edge of the chrome strip, before the search
  // input — lets the host inject stats so the chrome row IS the page toolbar.
  leadingChromeContent?: ReactNode;
};

const NOOP_NODE_ACTIVATE = (_payload: OrgChartNodeActivatePayload) => {};
const EMPTY_VISIBLE_FIELDS: string[] = [];

function defaultSearchText(node: OrgChartNode): string {
  return [
    node.name,
    node.title ?? "",
    node.slotLabel ?? "",
    ...Object.values(node.fieldValues).map((field) => field.value),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function resolveSearchText(node: OrgChartNode, searchText: OrgChartSearchText | undefined): string {
  if (!searchText) return defaultSearchText(node);
  if (typeof searchText === "function") return searchText(node).toLowerCase();
  return (searchText.get(node.id) ?? "").toLowerCase();
}

function containsSearchText(text: string, query: string): boolean {
  return text.indexOf(query) !== -1;
}

export function OrgChart(props: OrgChartProps) {
  const {
    data,
    renderNode,
    asOfDate,
    searchText,
    searchPlaceholder = "Search",
    searchLabel = "Search chart",
    visibleFields = EMPTY_VISIBLE_FIELDS,
    showSlots = false,
    slotMap,
    focusNodeIds,
    focusedNodeIds,
    onFocusConsumed,
    className,
    onNodeActivate = NOOP_NODE_ACTIVATE,
    leadingChromeContent,
  } = props;

  const [searchInput, setSearchInput] = useState("");
  const normalizedQuery = searchInput.trim().toLowerCase();
  const filterActive = normalizedQuery.length > 0;

  const canvasData = useMemo<OrgChartData>(() => {
    if (!filterActive) {
      return data;
    }
    return {
      ...data,
      nodes: data.nodes.map((node) => ({
        ...node,
        matchesFilter: containsSearchText(resolveSearchText(node, searchText), normalizedQuery),
      })),
    };
  }, [data, filterActive, normalizedQuery, searchText]);

  const matchCount = useMemo(() => {
    if (!filterActive) return 0;
    return canvasData.nodes.filter((node) => node.matchesFilter).length;
  }, [canvasData.nodes, filterActive]);

  const handleRef = useRef<ChartInstanceHandle | null>(null);

  const handleExpandAll = useCallback(() => {
    handleRef.current?.expandAll();
  }, []);

  const handleCollapseAll = useCallback(() => {
    handleRef.current?.collapseAll();
  }, []);

  const matchBadgeText = filterActive
    ? matchCount === 0
      ? "No matches"
      : `${matchCount} ${matchCount === 1 ? "match" : "matches"}`
    : null;

  const wrapperClass = ["org-chart-frame", className].filter(Boolean).join(" ");

  return (
    <div className={wrapperClass}>
      <div className="org-chart-chrome" data-org-chart-chrome>
        <div className="org-chart-chrome-left">
          {leadingChromeContent}
          <TextField
            size="sm"
            value={searchInput}
            onValueChange={setSearchInput}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            data-org-chart-search-input
            className="org-chart-search-input"
          />
          {matchBadgeText ? (
            <span
              data-org-chart-match-badge
              data-empty={matchCount === 0 ? "true" : undefined}
              className="org-chart-match-badge"
            >
              {matchBadgeText}
            </span>
          ) : null}
        </div>
        <div className="org-chart-chrome-right">
          <Button size="sm" intent="ghost" onClick={handleExpandAll} data-org-chart-expand-all>
            Expand all
          </Button>
          <Button size="sm" intent="ghost" onClick={handleCollapseAll} data-org-chart-collapse-all>
            Collapse all
          </Button>
        </div>
      </div>
      <div className="org-chart-canvas-slot">
        <OrgChartCanvas
          ref={handleRef}
          data={canvasData}
          renderNode={renderNode}
          visibleFields={visibleFields}
          asOfDate={asOfDate}
          filterActive={filterActive}
          showSlots={showSlots}
          slotMap={slotMap}
          focusNodeIds={focusNodeIds}
          focusedNodeIds={focusedNodeIds}
          onFocusConsumed={onFocusConsumed}
          onNodeActivate={onNodeActivate}
        />
      </div>
    </div>
  );
}
