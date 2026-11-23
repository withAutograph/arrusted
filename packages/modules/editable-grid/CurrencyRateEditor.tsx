"use client";

import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { AllCommunityModule, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact, type CustomCellEditorProps } from "ag-grid-react";
import { AgGridTheme } from "./theme";
import {
  effectiveCurrencyPeriods,
  validateCurrencyDate,
  validateCurrencyRate,
  type CurrencyRate,
} from "../../engines/currency/rates";
import { Button } from "../../design-systems/core/components/Button";
import { DatePickerCalendar } from "../../design-systems/core/components/date-picker";
import { Checkbox, TextField } from "../../design-systems/core/components/FormControls";
import { SegmentedControl } from "../../design-systems/core/components/SegmentedControl";
import { Typography } from "../../design-systems/core/components/Typography";
import { toIsoDateString } from "../../design-systems/core/components/date-picker/helpers";

export type CurrencyRateSaveInput = {
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  previousEffectiveEnd?: string | null;
  expectedVersionId?: string;
};
export type CurrencyRateEditorProps = {
  sourceCurrency: string;
  targetCurrency: string;
  rates: readonly CurrencyRate[];
  onSave: (input: CurrencyRateSaveInput) => Promise<void>;
  onUseAutomatic: (input: { effectiveStart: string }) => Promise<void>;
};

/** The caller supplies store.history(pair) and refreshes it after persistence succeeds. */
export function CurrencyRateEditor(props: CurrencyRateEditorProps) {
  return <PairEditor key={`${props.sourceCurrency}/${props.targetCurrency}`} {...props} />;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function PairEditor({
  sourceCurrency,
  targetCurrency,
  rates,
  onSave,
  onUseAutomatic,
}: CurrencyRateEditorProps) {
  const id = useId();
  const [editor, setEditor] = useState<"new" | "correct" | "automatic" | null>(null);
  const [rate, setRate] = useState("");
  const [inverse, setInverse] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [openEnded, setOpenEnded] = useState(true);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [editingVersionId, setEditingVersionId] = useState<string | undefined>();
  const [previousEffectiveEnd, setPreviousEffectiveEnd] = useState<string | null | undefined>();
  const [popupParent, setPopupParent] = useState<HTMLElement>();
  const history = effectiveCurrencyPeriods(rates, { sourceCurrency, targetCurrency });
  const custom = history.filter((row) => row.origin === "custom");

  useEffect(() => setPopupParent(document.body), []);

  function begin(mode: "new" | "correct" | "automatic", row?: CurrencyRate) {
    setEditor(mode);
    setRate(row?.rate ?? "");
    setInverse(row?.sourceCurrency === targetCurrency);
    setStart(row?.effectiveStart ?? toIsoDateString(new Date()));
    setEnd(row?.effectiveEnd ?? "");
    setOpenEnded(!row?.effectiveEnd);
    setError(null);
    setStatus("");
    setEditingVersionId(row?.versionId);
    setPreviousEffectiveEnd(mode === "correct" ? (row?.effectiveEnd ?? null) : undefined);
  }

  async function submit() {
    if (busy.current) return;
    setError(null);
    setStatus("");
    try {
      const input = {
        rate,
        sourceCurrency: inverse ? targetCurrency : sourceCurrency,
        targetCurrency: inverse ? sourceCurrency : targetCurrency,
        effectiveStart: start,
        effectiveEnd: openEnded ? null : end,
        ...(editor === "correct" && previousEffectiveEnd !== undefined
          ? { previousEffectiveEnd }
          : {}),
        ...(editor === "correct" && editingVersionId
          ? { expectedVersionId: editingVersionId }
          : {}),
      };
      if (editor === "automatic") validateCurrencyDate(start);
      else validateCurrencyRate({ ...input, origin: "custom" });
      busy.current = true;
      setPending(true);
      if (editor === "automatic") await onUseAutomatic({ effectiveStart: start });
      else await onSave(input);
      setStatus(
        editor === "automatic" ? "Automatic rates requested successfully." : "Custom rate saved.",
      );
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the rate. Try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const draft: Row = {
    sourceCurrency: inverse ? targetCurrency : sourceCurrency,
    targetCurrency: inverse ? sourceCurrency : targetCurrency,
    rate,
    effectiveStart: start,
    effectiveEnd: openEnded ? null : end,
    origin: editor === "automatic" ? "frankfurter" : "custom",
    draft: true,
  };
  const columns: ColDef<Row>[] = [
    {
      field: "effectiveStart",
      headerName: "Starts on",
      minWidth: 160,
      cellRenderer: StartCell,
      editable: ({ data }) => Boolean(data?.draft && editor !== "correct" && !pending),
      cellEditor: DateEditor,
      cellEditorPopup: true,
    },
    {
      field: "effectiveEnd",
      headerName: "Ends on",
      minWidth: 190,
      cellRenderer: EndCell,
      editable: ({ data }) =>
        Boolean(data?.draft && editor !== "automatic" && !openEnded && !pending),
      cellEditor: DateEditor,
      cellEditorPopup: true,
    },
    {
      field: "rate",
      headerName: "Rate",
      minWidth: 300,
      flex: 1,
      cellRenderer: RateCell,
    },
    { field: "origin", headerName: "Source", minWidth: 180, cellRenderer: SourceCell },
    { colId: "actions", headerName: "", minWidth: 210, cellRenderer: ActionsCell },
  ];
  const controls: Controls = {
    sourceCurrency,
    targetCurrency,
    inverse,
    setInverse,
    editor,
    pending,
    openEnded,
    setOpenEnded,
    setRate,
    rate,
    start,
    end,
    setStart,
    setEnd,
    cancel: () => setEditor(null),
    save: () => void submit(),
    edit: (row) => begin("correct", row),
  };

  return (
    <section
      aria-label={`Currency rates ${sourceCurrency} to ${targetCurrency}`}
      className="font-[family-name:var(--font-sans)] text-[var(--color-text-primary)]"
    >
      <header className="mb-[var(--space-3)] flex flex-wrap items-center justify-between gap-[var(--space-3)]">
        <Typography as="h2" variant="section-title">
          {sourceCurrency} ↔ {targetCurrency}
        </Typography>
        <div className="flex gap-[var(--space-2)]">
          {custom.length ? (
            <Button
              size="sm"
              type="button"
              disabled={pending || editor !== null}
              onClick={() => begin("automatic")}
            >
              Use automatic…
            </Button>
          ) : null}
          <Button
            size="sm"
            type="button"
            intent="primary"
            disabled={pending || editor !== null}
            onClick={() => begin("new")}
          >
            Add rate
          </Button>
        </div>
      </header>
      <ControlsContext.Provider value={controls}>
        <AgGridReact<Row>
          modules={[AllCommunityModule]}
          popupParent={popupParent}
          theme={AgGridTheme}
          domLayout="autoHeight"
          rowData={
            editor && editor !== "correct"
              ? [draft, ...history]
              : history.map((row) =>
                  editor === "correct" && row.origin === "custom" && row.effectiveStart === start
                    ? draft
                    : row,
                )
          }
          columnDefs={columns}
          defaultColDef={{
            resizable: true,
            sortable: false,
            cellDataType: false,
          }}
          getRowId={({ data }) => (data.draft ? "draft" : `${data.origin}/${data.effectiveStart}`)}
          getRowHeight={({ data }) => (data?.draft ? 88 : 52)}
          headerHeight={40}
          animateRows={false}
          suppressColumnVirtualisation
          overlayNoRowsTemplate="No rates yet. Add a custom rate or load automatic rates."
        />
      </ControlsContext.Provider>
      {editor ? (
        <Typography variant="caption" tone="muted" className="mt-[var(--space-2)]">
          {editor === "automatic"
            ? "Your custom rate ends before this date. Automatic rates apply until the next custom rate."
            : editor === "correct"
              ? "Correct this period without changing its start. End dates are inclusive."
              : "A new rate replaces your previous rate from its start date. End dates are inclusive."}
        </Typography>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="mt-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
        >
          {error}
        </p>
      ) : null}
      {status ? (
        <p
          role="status"
          className="mt-[var(--space-2)] text-[length:var(--text-caption)] text-[var(--color-text-secondary)]"
        >
          {status}
        </p>
      ) : null}
    </section>
  );
}

type Row = CurrencyRate & { draft?: boolean };
type Controls = {
  sourceCurrency: string;
  targetCurrency: string;
  inverse: boolean;
  setInverse: (value: boolean) => void;
  editor: "new" | "correct" | "automatic" | null;
  pending: boolean;
  openEnded: boolean;
  setOpenEnded: (value: boolean) => void;
  setRate: (value: string) => void;
  rate: string;
  start: string;
  end: string;
  setStart: (value: string) => void;
  setEnd: (value: string) => void;
  cancel: () => void;
  save: () => void;
  edit: (row: CurrencyRate) => void;
};
type Cell = ICellRendererParams<Row> & Controls;
const ControlsContext = createContext<Controls | null>(null);
function useControls(props: ICellRendererParams<Row>): Cell {
  return { ...props, ...useContext(ControlsContext)! };
}
const cellClass = "flex h-full items-center gap-[var(--space-2)]";
function DateButton({
  data,
  api,
  node,
  column,
  pending,
  editor,
  field,
}: Cell & { field: "effectiveStart" | "effectiveEnd" }) {
  const value = data?.[field];
  return (
    <Button
      size="sm"
      type="button"
      disabled={pending || (field === "effectiveStart" && editor === "correct")}
      aria-label={
        field === "effectiveEnd"
          ? "Period end (inclusive)"
          : editor === "automatic"
            ? "Automatic effective from"
            : "Period start"
      }
      onClick={() =>
        api.startEditingCell({
          rowIndex: node.rowIndex!,
          rowPinned: node.rowPinned,
          colKey: column!,
        })
      }
    >
      {value
        ? new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
            month: "short",
            day: "2-digit",
            year: "numeric",
          })
        : "Pick a date"}
    </Button>
  );
}
function StartCell(cell: ICellRendererParams<Row>) {
  const props = useControls(cell);
  return props.data?.draft ? (
    <div className={cellClass}>
      <DateButton {...props} field="effectiveStart" />
    </div>
  ) : (
    displayDate(props.data!.effectiveStart)
  );
}
function EndCell(cell: ICellRendererParams<Row>) {
  const props = useControls(cell);
  const { data, editor, pending, openEnded, setOpenEnded } = props;
  return data?.draft && editor !== "automatic" ? (
    <div className="grid h-full content-center gap-[var(--space-1)]">
      <Checkbox
        checked={openEnded}
        disabled={pending}
        label="No end date"
        onCheckedChange={setOpenEnded}
      />
      {!openEnded ? <DateButton {...props} field="effectiveEnd" /> : null}
    </div>
  ) : data?.effectiveEnd ? (
    displayDate(data.effectiveEnd)
  ) : (
    "Ongoing"
  );
}
function RateCell(cell: ICellRendererParams<Row>) {
  const {
    data,
    editor,
    pending,
    setRate,
    rate,
    inverse,
    setInverse,
    sourceCurrency,
    targetCurrency,
  } = useControls(cell);
  return data?.draft ? (
    editor === "automatic" ? (
      "Automatic"
    ) : (
      <fieldset
        disabled={pending}
        className="grid h-full min-w-0 content-center gap-[var(--space-1)]"
      >
        <SegmentedControl
          size="sm"
          intent="neutral"
          ariaLabel="Quote direction"
          value={inverse ? "inverse" : "direct"}
          options={[
            { value: "direct", label: `${sourceCurrency} → ${targetCurrency}` },
            { value: "inverse", label: `${targetCurrency} → ${sourceCurrency}` },
          ]}
          onChange={(direction) => setInverse(direction === "inverse")}
        />
        <div className="flex items-center gap-[var(--space-2)]">
          <span className="shrink-0">1 {data.sourceCurrency} =</span>
          <TextField
            aria-label="Rate"
            size="sm"
            inputMode="decimal"
            placeholder="0.00"
            value={rate}
            disabled={pending}
            onValueChange={setRate}
          />
          <span>{data.targetCurrency}</span>
        </div>
      </fieldset>
    )
  ) : (
    <span>
      1 {data?.sourceCurrency} = <span>{data?.rate}</span> {data?.targetCurrency}
    </span>
  );
}
function SourceCell({ data }: ICellRendererParams<Row>) {
  return (
    <div className="grid h-full content-center leading-normal">
      <span>{data?.origin === "custom" ? "Custom" : "Automatic · Frankfurter"}</span>
      {data?.observationDate ? (
        <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          Reference date {displayDate(data.observationDate)}
        </span>
      ) : null}
    </div>
  );
}
function ActionsCell(cell: ICellRendererParams<Row>) {
  const { data, editor, pending, save, cancel, edit } = useControls(cell);
  return (
    <div className={cellClass}>
      {data?.draft ? (
        <>
          <Button size="xs" type="button" intent="primary" loading={pending} onClick={save}>
            {editor === "automatic" ? "Use automatic rates" : "Save rate"}
          </Button>
          <Button size="xs" type="button" intent="ghost" disabled={pending} onClick={cancel}>
            Cancel
          </Button>
        </>
      ) : data?.origin === "custom" ? (
        <Button
          size="xs"
          type="button"
          intent="ghost"
          disabled={pending}
          aria-label={`Edit custom rate starting ${data.effectiveStart}`}
          onClick={() => edit(data)}
        >
          Edit
        </Button>
      ) : null}
    </div>
  );
}

function DateEditor({ column, api }: CustomCellEditorProps<Row, string>) {
  const controls = useContext(ControlsContext)!;
  const isStart = column.getColId() === "effectiveStart";
  return (
    <div
      className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]"
      style={{
        width: "var(--size-date-picker-popover)",
        height: "var(--size-date-picker-popover)",
      }}
    >
      <DatePickerCalendar
        value={isStart ? controls.start : controls.end}
        onSelect={(next) => {
          if (!next) return;
          (isStart ? controls.setStart : controls.setEnd)(next);
          api.stopEditing(true);
        }}
      />
    </div>
  );
}
