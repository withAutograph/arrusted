import { useId, useState, type ReactNode } from "react";

import { Button, type ButtonIntent } from "../components/Button";
import { Disclosure } from "../components/Disclosure";
import { Checkbox, FieldFrame, Select, TextArea, TextField } from "../components/FormControls";
import { SegmentedControl } from "../components/SegmentedControl";
import { StatusPill, type StatusPillTone } from "../components/StatusPill";
import { cx, focusRing } from "../components/utils";
import { Close } from "../icons";
import { DataTableComposition, type DataTableSpec, type SerializableCellValue } from "./DataTable";
import type { CompositionSpec } from "./spec";

export type RecordDetailValue = SerializableCellValue;

export type RecordDetailTabSpec = {
  id: string;
  label: string;
};

export type RecordDetailOptionSpec = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type RecordDetailFieldSpec = {
  type: "field";
  id: string;
  label: string;
  value?: RecordDetailValue;
  helper?: string;
  emptyLabel?: string;
  layout?: "inline" | "stacked";
  control?: "text" | "textarea" | "number" | "date" | "select" | "checkbox";
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  options?: RecordDetailOptionSpec[];
};

export type RecordDetailTableSpec = DataTableSpec & {
  type: "table";
  id: string;
};

export type RecordDetailNoteSpec = {
  type: "note";
  id: string;
  title?: string;
  body: string;
  tone?: "neutral" | "info" | "warning" | "danger";
};

export type RecordDetailItemSpec =
  | RecordDetailFieldSpec
  | RecordDetailTableSpec
  | RecordDetailNoteSpec;

export type RecordDetailSectionSpec = {
  id: string;
  title: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
  items: RecordDetailItemSpec[];
};

/** Host-only section behavior for a rendered record detail panel. */
export type RecordDetailPanelSectionSpec = RecordDetailSectionSpec & {
  onOpenChange?: (open: boolean) => void;
  /** Leaves a non-collapsible section's heading out, e.g. a record's only section. */
  hideTitle?: boolean;
};

export type RecordDetailMetadataSpec = {
  id: string;
  label?: string;
  value: string;
};

export type RecordDetailSpec = {
  title: string;
  subtitle?: string;
  status?: { label: string; tone?: StatusPillTone; detail?: string };
  metadata?: RecordDetailMetadataSpec[];
  sections: RecordDetailSectionSpec[];
  emptyValueLabel?: string;
  tabs?: RecordDetailTabSpec[];
  activeTabId?: string;
};

export type RecordDetailAction = {
  id: string;
  label: ReactNode;
  intent?: ButtonIntent;
  disabled?: boolean;
  loading?: boolean;
};

export type RecordDetailPanelProps = Omit<
  RecordDetailSpec,
  "title" | "subtitle" | "status" | "sections"
> & {
  title: ReactNode;
  subtitle?: ReactNode;
  status?: { label: ReactNode; tone?: StatusPillTone; detail?: ReactNode };
  sections: RecordDetailPanelSectionSpec[];
  mode?: "read" | "edit";
  /**
   * For a host that already names the record and scrolls, e.g. a drawer: the
   * panel drops its own header, card chrome and scroll region and renders
   * only its sections, flat (they do not collapse). A string `title` still
   * names the panel for assistive tech.
   */
  embedded?: boolean;
  /** Emphasizes read-only field labels when they are primary decision context. */
  labelEmphasis?: "secondary" | "primary";
  /** Renders actions once in the header instead of the default footer. */
  actionsPlacement?: "header";
  values?: Readonly<Record<string, RecordDetailValue>>;
  /**
   * The values `values` replaced. In edit mode a changed field offers its
   * previous value and a revert; in read mode it shows a quiet "was …" line.
   */
  originalValues?: Readonly<Record<string, RecordDetailValue>>;
  /** A quiet note under a field's value in read mode, e.g. who changed it. */
  fieldNotes?: Readonly<Record<string, ReactNode>>;
  errors?: Readonly<Record<string, ReactNode>>;
  actions?: readonly RecordDetailAction[];
  className?: string;
  onValueChange?: (fieldId: string, value: RecordDetailValue) => void;
  onRevertField?: (fieldId: string, originalValue: RecordDetailValue) => void;
  onAction?: (actionId: string) => void;
  onFieldSelect?: (fieldId: string) => void;
  onEdit?: () => void;
  onClose?: () => void;
  onTabChange?: (tabId: string) => void;
  editLabel?: ReactNode;
  closeLabel?: string;
  revertLabel?: ReactNode;
  previousValueLabel?: (field: RecordDetailFieldSpec, value: RecordDetailValue) => ReactNode;
  renderValue?: (field: RecordDetailFieldSpec, value: RecordDetailValue) => ReactNode;
  renderEditor?: (args: {
    field: RecordDetailFieldSpec;
    value: RecordDetailValue;
    error?: ReactNode;
    inputId: string;
    describedBy?: string;
    disabled: boolean;
    onValueChange: (value: RecordDetailValue) => void;
  }) => ReactNode | undefined;
  renderItem?: (item: RecordDetailItemSpec) => ReactNode | undefined;
};

export function RecordDetailPanel(props: RecordDetailPanelProps) {
  const headingId = useId();
  const {
    title,
    subtitle,
    status,
    metadata,
    sections,
    emptyValueLabel = "Not provided",
    mode = "read",
    actions,
    actionsPlacement,
    className,
    tabs,
    activeTabId = tabs?.[0]?.id,
  } = props;
  const hasHeaderActions = actionsPlacement === "header" && Boolean(actions?.length);

  if (props.embedded) {
    return (
      <article
        className={cx(
          "@container/record-detail flex min-w-[var(--space-0)] w-full max-w-full flex-col text-[var(--color-text-primary)]",
          className,
        )}
        aria-label={typeof title === "string" ? title : undefined}
      >
        {sections.map((section) => (
          <RecordDetailSection
            key={section.id}
            section={section}
            mode={mode}
            emptyValueLabel={emptyValueLabel}
            panelProps={props}
          />
        ))}
      </article>
    );
  }

  return (
    <article
      className={cx(
        "@container/record-detail flex min-h-[var(--space-0)] min-w-[var(--space-0)] w-full max-w-full flex-col overflow-hidden rounded-[var(--radius-record-detail-panel)] border-0 bg-[var(--color-bg-surface)] text-[var(--color-text-primary)] shadow-[var(--shadow-card-soft)]",
        className,
      )}
      data-appearance="flat"
      aria-labelledby={headingId}
    >
      <header
        className={cx(
          "border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
          hasHeaderActions ? "px-[var(--space-6)] py-[var(--space-4)]" : "p-[var(--space-6)]",
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
          <div className="min-w-[var(--space-0)] flex-1">
            <h2
              id={headingId}
              className="m-0 break-words text-[length:var(--text-record-detail-title)] font-[var(--font-weight-semibold)] leading-[var(--leading-record-detail-title)]"
            >
              {title}
            </h2>
          </div>
          {status || props.onEdit || props.onClose ? (
            <div className="flex max-w-full shrink-0 flex-wrap items-center justify-end gap-[var(--space-2)]">
              {status ? (
                <StatusPill
                  label={status.label}
                  tone={status.tone}
                  detail={status.detail}
                  size="xs"
                />
              ) : null}
              {props.onEdit ? (
                <Button size="sm" intent="secondary" onClick={props.onEdit}>
                  {props.editLabel ?? "Edit"}
                </Button>
              ) : null}
              {props.onClose ? (
                <button
                  type="button"
                  aria-label={props.closeLabel ?? "Close panel"}
                  onClick={props.onClose}
                  className={cx(
                    "-mr-[var(--space-2)] inline-flex h-[var(--size-control-sm)] w-[var(--size-control-sm)] shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)]",
                    focusRing,
                  )}
                >
                  <Close className="h-[var(--size-icon-md)] w-[var(--size-icon-md)]" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {subtitle ? (
          <div className="mt-[var(--space-0-5)] min-w-[var(--space-0)] break-words text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            {subtitle}
          </div>
        ) : null}
        {metadata?.length ? (
          <dl className="mt-[var(--space-3)] flex flex-wrap gap-x-[var(--space-4)] gap-y-[var(--space-1)] text-[length:var(--text-record-detail-meta)] leading-[var(--leading-record-detail-meta)] text-[var(--color-text-muted)]">
            {metadata.map((item) => (
              <div key={item.id} className="flex min-w-[var(--space-0)] gap-[var(--space-1)]">
                {item.label ? (
                  <dt className="font-[var(--font-weight-semibold)]">{item.label}:</dt>
                ) : null}
                <dd className="m-0 min-w-[var(--space-0)] break-words">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {hasHeaderActions ? (
          <div className="mt-[var(--space-2)] flex flex-wrap justify-end gap-[var(--space-2)]">
            {actions?.map((action) => (
              <Button
                key={action.id}
                intent={action.intent}
                disabled={action.disabled || !props.onAction}
                loading={action.loading}
                onClick={() => props.onAction?.(action.id)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </header>

      {tabs?.length && activeTabId ? (
        <nav
          aria-label="Record detail views"
          className={cx(
            "border-b border-[var(--color-border-subtle)] px-[var(--space-6)] py-[var(--space-4)]",
          )}
        >
          <SegmentedControl
            value={activeTabId}
            options={tabs.map((tab) => ({ value: tab.id, label: tab.label }))}
            onChange={(next) => props.onTabChange?.(next)}
            intent="neutral"
            size="lg"
            ariaLabel="Record detail view"
            // Figma sidepanel tabs are equal thirds of the strip with
            // Body (Bold) 14/20 labels, so each segment takes a flex-basis
            // of 0 rather than sizing to its label. `grid` here would lose
            // to the control's own `inline-flex` (cx does not merge
            // conflicting display utilities).
            className="w-full p-[var(--space-0-5)] [&>[data-segmented-option]]:flex-1 [&>[data-segmented-option]]:text-center [&>[data-segmented-option]]:font-[var(--font-weight-semibold)] [&>[data-segmented-option]]:leading-[var(--leading-body)]"
          />
        </nav>
      ) : null}

      <div
        role="region"
        aria-labelledby={headingId}
        tabIndex={0}
        className={cx(
          "min-w-[var(--space-0)] flex-1 overflow-y-auto p-[var(--space-0)] focus-visible:ring-inset",
          focusRing,
        )}
      >
        <div className={cx("grid min-w-[var(--space-0)] gap-[var(--space-0)]")}>
          {sections.map((section) => (
            <RecordDetailSection
              key={section.id}
              section={section}
              mode={mode}
              emptyValueLabel={emptyValueLabel}
              panelProps={props}
            />
          ))}
        </div>
      </div>

      {actions?.length && !hasHeaderActions ? (
        <footer className="flex flex-wrap justify-end gap-[var(--space-2)] border-t border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-5)] py-[var(--space-3)]">
          {actions.map((action) => (
            <Button
              key={action.id}
              intent={action.intent}
              disabled={action.disabled || !props.onAction}
              loading={action.loading}
              onClick={() => props.onAction?.(action.id)}
            >
              {action.label}
            </Button>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

function RecordDetailSection(props: {
  section: RecordDetailPanelSectionSpec;
  mode: "read" | "edit";
  emptyValueLabel: string;
  panelProps: RecordDetailPanelProps;
}) {
  const { section } = props;
  const embedded = props.panelProps.embedded === true;
  const content = (
    <div
      className={cx(
        embedded ? "grid" : "grid px-[var(--space-6)] pb-[var(--space-4)]",
        // Figma stacks label/content pairs on a 40px pitch: a 36px row
        // (8 + 20 + 8) plus a 4px gap.
        props.mode === "read" && "gap-[var(--space-1)]",
        props.mode === "edit" && "gap-[var(--space-3)]",
      )}
    >
      {section.items.map((item) => (
        <RecordDetailItem key={item.id} item={item} {...props} />
      ))}
    </div>
  );

  if (embedded) {
    // The host frames and pads the panel; sections are separated by a hairline.
    return (
      <section className="min-w-[var(--space-0)] border-b border-[var(--color-border-subtle)] py-[var(--space-3)] first:pt-[var(--space-0)] last:border-b-0 last:pb-[var(--space-0)]">
        {section.hideTitle ? null : (
          <h3 className="m-0 pb-[var(--space-2)] text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
            {section.title}
          </h3>
        )}
        {content}
      </section>
    );
  }

  if (section.collapsible === false && section.hideTitle) {
    return (
      <section className="min-w-[var(--space-0)] overflow-hidden rounded-[var(--space-0)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] pt-[var(--space-4)]">
        {content}
      </section>
    );
  }

  return (
    <section
      className={cx(
        "min-w-[var(--space-0)] overflow-hidden rounded-[var(--space-0)] border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
      )}
    >
      {section.collapsible === false ? (
        <>
          <h3 className="m-0 p-[var(--space-6)] pb-[var(--space-2)] text-[length:var(--text-section-title)] font-[var(--font-weight-medium)] leading-[var(--leading-title)]">
            {section.title}
          </h3>
          {content}
        </>
      ) : (
        <Disclosure
          defaultOpen={section.defaultOpen !== false}
          onOpenChange={section.onOpenChange}
          summary={<span className="min-w-[var(--space-0)] break-words">{section.title}</span>}
          caretPosition="end"
          caretSize="md"
          caretMotion="up-down"
          className="[&[open]>summary]:pb-[var(--space-2)]"
          summaryClassName="p-[var(--space-6)] text-[length:var(--text-section-title)] font-[var(--font-weight-medium)] leading-[var(--leading-title)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-action-primary)]"
        >
          {content}
        </Disclosure>
      )}
    </section>
  );
}

function RecordDetailItem(props: {
  item: RecordDetailItemSpec;
  mode: "read" | "edit";
  emptyValueLabel: string;
  panelProps: RecordDetailPanelProps;
}) {
  const generatedId = useId();
  const inputId = `record-detail-field-${generatedId}`;
  const hasMessage = Boolean(
    props.item.type === "field" && (props.panelProps.errors?.[props.item.id] || props.item.helper),
  );
  const describedBy = hasMessage ? `${inputId}-message` : undefined;
  const custom = props.panelProps.renderItem?.(props.item);
  if (custom !== undefined) return custom;

  if (props.item.type === "table") {
    const table: DataTableSpec = {
      columns: props.item.columns,
      rows: props.item.rows,
      emptyLabel: props.item.emptyLabel,
      density: props.item.density,
      frame: "flat",
      ariaLabel: props.item.ariaLabel,
    };
    return (
      <div className="min-w-[var(--space-0)] py-[var(--space-2)]">
        <div className="min-w-[var(--space-0)] max-w-full">
          <DataTableComposition
            spec={{ type: "data_table", config: { ...table, density: table.density ?? "compact" } }}
          />
        </div>
      </div>
    );
  }

  if (props.item.type === "note") {
    return (
      <div
        className={cx(
          "rounded-[var(--radius-control)] border px-[var(--space-3)] py-[var(--space-2-5)] text-[length:var(--text-caption)]",
          props.mode === "read" && "my-[var(--space-3)]",
          noteToneClass[props.item.tone ?? "neutral"],
        )}
      >
        {props.item.title ? <strong className="block">{props.item.title}</strong> : null}
        <p className="m-0">{props.item.body}</p>
      </div>
    );
  }

  const controlledValues = props.panelProps.values;
  const value =
    controlledValues && Object.hasOwn(controlledValues, props.item.id)
      ? (controlledValues[props.item.id] ?? null)
      : (props.item.value ?? null);
  const originalValues = props.panelProps.originalValues;
  const hasOriginalValue = Boolean(originalValues && Object.hasOwn(originalValues, props.item.id));
  const originalValue = hasOriginalValue
    ? (originalValues?.[props.item.id] ?? null)
    : (props.item.value ?? null);
  const isDirty = Boolean(
    props.panelProps.onRevertField && hasOriginalValue && !sameDetailValue(value, originalValue),
  );
  const dirtyNoticeId = isDirty ? `${inputId}-dirty` : undefined;
  const editorDescribedBy = [describedBy, dirtyNoticeId].filter(Boolean).join(" ") || undefined;
  if (props.mode === "edit" && props.item.control) {
    const editorDisabled = props.item.disabled || !props.panelProps.onValueChange;
    const onValueChange = (next: RecordDetailValue) =>
      props.panelProps.onValueChange?.(props.item.id, next);
    const customEditor = props.panelProps.renderEditor?.({
      field: props.item,
      value,
      error: props.panelProps.errors?.[props.item.id],
      inputId,
      describedBy: editorDescribedBy,
      disabled: editorDisabled,
      onValueChange,
    });
    if (customEditor !== undefined) {
      return (
        <div className="rounded-[var(--radius-control)]" data-field-id={props.item.id}>
          {customEditor}
          {isDirty ? (
            <DirtyFieldNotice
              field={props.item}
              originalValue={originalValue}
              panelProps={props.panelProps}
              emptyValueLabel={props.emptyValueLabel}
              id={dirtyNoticeId}
            />
          ) : null}
        </div>
      );
    }
    if (props.item.control === "checkbox") {
      const error = props.panelProps.errors?.[props.item.id];
      return (
        <div
          className="grid gap-[var(--space-1)] rounded-[var(--radius-control)]"
          data-field-id={props.item.id}
        >
          <Checkbox
            checked={value === true}
            disabled={editorDisabled}
            required={props.item.required}
            label={props.item.label}
            id={inputId}
            aria-describedby={editorDescribedBy}
            aria-invalid={Boolean(error)}
            onCheckedChange={onValueChange}
          />
          {error ? (
            <span
              id={describedBy}
              className="text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
            >
              {error}
            </span>
          ) : props.item.helper ? (
            <span
              id={describedBy}
              className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
            >
              {props.item.helper}
            </span>
          ) : null}
          {isDirty ? (
            <DirtyFieldNotice
              field={props.item}
              originalValue={originalValue}
              panelProps={props.panelProps}
              emptyValueLabel={props.emptyValueLabel}
              id={dirtyNoticeId}
            />
          ) : null}
        </div>
      );
    }
    return (
      <div className="rounded-[var(--radius-control)]" data-field-id={props.item.id}>
        <FieldFrame
          label={props.item.label}
          helper={props.item.helper}
          error={props.panelProps.errors?.[props.item.id]}
          required={props.item.required}
          htmlFor={inputId}
          messageId={describedBy}
        >
          {renderEditor(
            props.item,
            value,
            onValueChange,
            inputId,
            editorDescribedBy,
            Boolean(props.panelProps.errors?.[props.item.id]),
            editorDisabled,
            props.item.emptyLabel ?? props.emptyValueLabel,
          )}
        </FieldFrame>
        {isDirty ? (
          <DirtyFieldNotice
            field={props.item}
            originalValue={originalValue}
            panelProps={props.panelProps}
            emptyValueLabel={props.emptyValueLabel}
            id={dirtyNoticeId}
          />
        ) : null}
      </div>
    );
  }

  const customValue = props.panelProps.renderValue?.(props.item, value);
  // Read mode: a value that replaced another shows what it was.
  const changed = hasOriginalValue && !sameDetailValue(value, originalValue);
  const note = props.panelProps.fieldNotes?.[props.item.id];
  return (
    <dl className="min-w-[var(--space-0)] py-[var(--space-2)]" data-field-id={props.item.id}>
      <div
        className={cx(
          "grid min-w-[var(--space-0)] gap-[var(--space-1)] @sm/record-detail:gap-x-[var(--space-4)]",
          props.item.layout === "stacked"
            ? "@sm/record-detail:grid-cols-1"
            : "@sm/record-detail:grid-cols-[var(--size-record-detail-label-column)_minmax(var(--size-detail-value-column),1fr)] @sm/record-detail:gap-y-[var(--space-0)]",
        )}
      >
        <dt
          className={cx(
            "min-w-[var(--space-0)] font-[var(--font-weight-semibold)]",
            props.panelProps.labelEmphasis === "primary"
              ? "text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-primary)]"
              : "text-[length:var(--text-caption)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]",
          )}
        >
          {props.mode === "read" && props.panelProps.onFieldSelect ? (
            <button
              type="button"
              className={cx(
                "text-left text-inherit hover:text-[var(--color-action-primary-ink)]",
                focusRing,
              )}
              onClick={() => props.panelProps.onFieldSelect?.(props.item.id)}
            >
              {props.item.label}
            </button>
          ) : (
            props.item.label
          )}
          {props.item.helper ? (
            <span className="mt-[var(--space-0-5)] block text-[length:var(--text-micro)] font-[var(--font-weight-normal)] text-[var(--color-text-muted)]">
              {props.item.helper}
            </span>
          ) : null}
        </dt>
        <dd className="m-0 min-w-[var(--space-0)] break-words text-[length:var(--text-body)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
          {customValue !== undefined
            ? customValue
            : renderValue(value, props.item.emptyLabel ?? props.emptyValueLabel)}
          {changed || note ? (
            <span className="mt-[var(--space-0-5)] flex min-w-[var(--space-0)] flex-wrap items-center gap-x-[var(--space-1)] text-[length:var(--text-micro)] leading-[var(--leading-caption)] text-[var(--color-text-muted)]">
              {note}
              {changed ? (
                <span data-previous-value>
                  was{" "}
                  {props.panelProps.previousValueLabel?.(props.item, originalValue) ??
                    renderFieldValue(
                      props.item,
                      originalValue,
                      props.item.emptyLabel ?? props.emptyValueLabel,
                    )}
                </span>
              ) : null}
            </span>
          ) : null}
        </dd>
      </div>
    </dl>
  );
}

function DirtyFieldNotice(props: {
  field: RecordDetailFieldSpec;
  originalValue: RecordDetailValue;
  panelProps: RecordDetailPanelProps;
  emptyValueLabel: string;
  id?: string;
}) {
  if (!props.panelProps.onRevertField) return null;
  const previous =
    props.panelProps.previousValueLabel?.(props.field, props.originalValue) ??
    renderFieldValue(props.field, props.originalValue, props.emptyValueLabel);
  return (
    <div
      id={props.id}
      className="flex min-w-[var(--space-0)] items-center justify-between gap-[var(--space-2)] rounded-[var(--radius-control)] bg-[var(--color-status-warning-bg)] px-[var(--space-2)] py-[var(--space-1)] text-[length:var(--text-caption)] text-[var(--color-text-muted)]"
    >
      <span className="min-w-[var(--space-0)] truncate">Previous: {previous}</span>
      <Button
        intent="ghost"
        size="xs"
        className="shrink-0"
        aria-label={`Revert ${props.field.label}`}
        onClick={() => props.panelProps.onRevertField?.(props.field.id, props.originalValue)}
      >
        {props.panelProps.revertLabel ?? "Revert"}
      </Button>
    </div>
  );
}

function renderFieldValue(
  field: RecordDetailFieldSpec,
  value: RecordDetailValue,
  emptyValueLabel: string,
) {
  if (field.control === "select" && typeof value === "string") {
    return field.options?.find((option) => option.value === value)?.label ?? value;
  }
  return renderValue(value, field.emptyLabel ?? emptyValueLabel);
}

function renderEditor(
  field: RecordDetailFieldSpec,
  value: RecordDetailValue,
  onValueChange: (value: RecordDetailValue) => void,
  inputId: string,
  describedBy: string | undefined,
  invalid: boolean,
  disabled: boolean,
  emptyValueLabel: string,
) {
  if (field.control === "select") {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        id={inputId}
        disabled={disabled}
        required={field.required}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        options={[
          {
            value: "",
            label: emptyValueLabel,
            disabled: Boolean(field.required),
          },
          ...(field.options ?? []),
        ]}
        onValueChange={(next) => onValueChange(next === "" ? null : next)}
      />
    );
  }
  if (field.control === "textarea") {
    return (
      <TextArea
        value={typeof value === "string" ? value : ""}
        id={inputId}
        disabled={disabled}
        required={field.required}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        placeholder={field.placeholder}
        onValueChange={onValueChange}
      />
    );
  }
  if (field.control === "number") {
    return (
      <NumberEditor
        id={inputId}
        value={typeof value === "number" ? value : null}
        disabled={disabled}
        required={field.required}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        placeholder={field.placeholder}
        onValueChange={onValueChange}
      />
    );
  }
  return (
    <TextField
      type={field.control === "date" ? "date" : "text"}
      id={inputId}
      value={value === null ? "" : String(value)}
      disabled={disabled}
      required={field.required}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      placeholder={field.placeholder}
      onValueChange={onValueChange}
    />
  );
}

function NumberEditor(props: {
  id: string;
  value: number | null;
  disabled: boolean;
  required?: boolean;
  "aria-describedby"?: string;
  "aria-invalid": boolean;
  placeholder?: string;
  onValueChange: (value: RecordDetailValue) => void;
}) {
  const valueText = props.value === null ? "" : String(props.value);
  const [previousValueText, setPreviousValueText] = useState(valueText);
  const [draft, setDraft] = useState(valueText);
  if (valueText !== previousValueText) {
    setPreviousValueText(valueText);
    setDraft(valueText);
  }
  return (
    <TextField
      type="text"
      inputMode="decimal"
      id={props.id}
      value={draft}
      disabled={props.disabled}
      required={props.required}
      aria-describedby={props["aria-describedby"]}
      aria-invalid={props["aria-invalid"]}
      placeholder={props.placeholder}
      onValueChange={(next) => {
        setDraft(next);
        if (next === "") {
          props.onValueChange(null);
          return;
        }
        if (!decimalPattern.test(next)) return;
        const parsed = Number(next);
        if (Number.isFinite(parsed)) props.onValueChange(parsed);
      }}
    />
  );
}

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function renderValue(value: RecordDetailValue, emptyLabel: string) {
  if (value === null || value === "") {
    return <span className="text-[var(--color-text-disabled)]">{emptyLabel}</span>;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

const noteToneClass = {
  neutral:
    "border-[var(--color-border-subtle)] bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)]",
  info: "border-[var(--color-action-primary)] bg-[var(--color-bg-subtle)] text-[var(--color-text-primary)]",
  warning:
    "border-[var(--color-status-warning)] bg-[var(--color-status-warning-bg)] text-[var(--color-text-primary)]",
  danger:
    "border-[var(--color-status-danger)] bg-[var(--color-status-danger-bg)] text-[var(--color-text-primary)]",
} as const;

export function RecordDetailComposition(props: {
  spec: CompositionSpec<"record_detail", RecordDetailSpec>;
}) {
  return <RecordDetailPanel {...props.spec.config} />;
}

/**
 * Read mode's "was …" cue compares by value, not identity: a host that
 * rebuilds its values each render (or passes structured values at runtime)
 * must not show a change where none happened.
 */
function sameDetailValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null)
    return false;
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : entry,
  );
}
