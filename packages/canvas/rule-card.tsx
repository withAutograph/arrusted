import { Fragment, useMemo, useState, type ReactNode } from "react";

import type {
  DataDefinition,
  DataField,
  DataModel,
  WorkRuleParameter,
} from "@autograph/generated-app-runtime/data";
import {
  createLabelIndex,
  fieldHeader,
  type LabelIndex,
} from "@autograph/work-session-tools/labels";
import {
  BoolCellEditor,
  ConfirmButton,
  DateField,
  DatetimeEditor,
  MoneyRateEditor,
  NumberCellEditor,
  Tag,
  TextCellEditor,
  cx,
  focusRing,
  moneyRateDefaultCurrencies,
  type EditorContext,
  type FieldEditor,
} from "@autograph/components";
import type { Comparison, DerivedExpr, Field, TypedLiteral } from "@contracts";
import { formatField } from "@engines/format";

import { columnHeader } from "./review-labels";
import type { CanvasOutcome, CanvasSession } from "./use-canvas-session";

export type CanvasRule = CanvasSession["rules"][number];

const comparison: Record<Comparison, string> = {
  eq: "is",
  not_eq: "is not",
  lt: "is less than",
  lte: "is at most",
  gt: "is more than",
  gte: "is at least",
};
const periodWords: Record<string, string> = {
  hourly: "an hourly",
  daily: "a daily",
  weekly: "a weekly",
  monthly: "a monthly",
  annual: "an annual",
};
const arithmetic = { add: "+", subtract: "−", multiply: "×", divide: "÷" } as const;

/** A parameter's name in words: `raise_pct` reads "raise pct". */
const parameterName = (name: string) => name.replaceAll(/[_-]+/g, " ").trim();

const formatAs = (value: WorkRuleParameter | TypedLiteral, field?: DataField) =>
  formatField(
    value as never,
    (field ?? { id: "", type: value.type }) as Pick<Field, "id" | "label" | "type" | "option_set">,
  );

type Words = {
  labels: LabelIndex;
  models: readonly DataModel[];
  model: DataModel | undefined;
  parameter: (name: string) => ReactNode;
};

/** The column a field expression reads, for naming literals compared with it (enum options). */
function fieldOf(words: Words, expr: DerivedExpr): DataField | undefined {
  if (expr.type === "field") return words.labels.fieldById(words.model, expr.field);
  if (expr.type === "relation_field") {
    const relation = words.labels.fieldById(words.model, expr.relation);
    const target =
      typeof relation?.target_model === "string"
        ? words.labels.modelById(relation.target_model)
        : undefined;
    return words.labels.fieldById(target, expr.field);
  }
  return undefined;
}

const Column = ({ children }: { children: ReactNode }) => (
  <span className="font-[var(--font-weight-medium)] text-[var(--color-text-primary)]">
    {children}
  </span>
);

/** A rule expression in words, with column headers for field ids and inputs for parameters. */
function say(words: Words, expr: DerivedExpr, context?: DataField, nested = false): ReactNode {
  const { labels, model } = words;
  const join = (items: readonly DerivedExpr[], last: string) =>
    items.map((item, index) => (
      <Fragment key={index}>
        {index === 0 ? null : index === items.length - 1 ? ` ${last} ` : ", "}
        {say(words, item, context, true)}
      </Fragment>
    ));
  switch (expr.type) {
    case "field":
      return (
        <Column>
          {model === undefined ? "a removed column" : columnHeader(labels, model.id, expr.field)}
        </Column>
      );
    case "relation_field": {
      const relation = labels.fieldById(model, expr.relation);
      const target = fieldOf(words, expr);
      return (
        <Column>
          {relation === undefined ? "a removed column" : fieldHeader(relation)}’s{" "}
          {target === undefined ? "a removed column" : fieldHeader(target)}
        </Column>
      );
    }
    case "literal": {
      const text = formatAs(expr.value, context);
      return expr.value.type === "text" ? `“${text}”` : text;
    }
    case "parameter":
      return words.parameter(expr.parameter);
    case "coalesce":
      return <>the first of {join(expr.expressions, "or")} that is set</>;
    case "concat":
      return <>{join(expr.expressions, "followed by")}</>;
    case "add":
    case "subtract":
    case "multiply":
    case "divide": {
      const side = (operand: DerivedExpr) =>
        say(words, operand, context ?? fieldOf(words, operand), true);
      const body = (
        <>
          {side(expr.left)} {arithmetic[expr.type]} {side(expr.right)}
        </>
      );
      return nested ? <>({body})</> : body;
    }
    case "normalize_money_rate":
      return (
        <>
          {say(words, expr.expression, context, true)} as {periodWords[expr.period] ?? expr.period}{" "}
          rate
        </>
      );
    case "inverse_aggregate": {
      // The relation is a column on the related model pointing back at this one.
      const related = words.models.find((item) =>
        item.fields.some((field) => field.id === expr.inverse_relation),
      );
      const what = related === undefined ? "related records" : labels.modelLabel(related.id);
      const verb = {
        count: "the number of",
        sum: "the total",
        min: "the lowest",
        max: "the highest",
      }[expr.aggregate];
      return (
        <>
          {verb}{" "}
          {expr.expression == null ? null : (
            <>{say({ ...words, model: related }, expr.expression, undefined, true)} across </>
          )}
          {what}
          {expr.filter == null ? null : " that match a filter"}
        </>
      );
    }
    case "compare": {
      const left = fieldOf(words, expr.left);
      const right = fieldOf(words, expr.right);
      return (
        <>
          {say(words, expr.left, right, true)} {comparison[expr.op]}{" "}
          {say(words, expr.right, left, true)}
        </>
      );
    }
    case "if":
      return (
        <>
          {say(words, expr.then, context, true)} when {say(words, expr.condition, undefined, true)},
          otherwise {say(words, expr.else, context, true)}
        </>
      );
    case "min":
    case "max":
      return (
        <>
          the {expr.type === "min" ? "smaller" : "larger"} of {say(words, expr.left, context, true)}{" "}
          and {say(words, expr.right, context, true)}
        </>
      );
    case "clamp":
      return (
        <>
          {say(words, expr.expression, context, true)}, kept between{" "}
          {say(words, expr.min, context, true)} and {say(words, expr.max, context, true)}
        </>
      );
  }
}

const editors: Partial<Record<WorkRuleParameter["type"], FieldEditor<unknown, never, unknown>>> = {
  text: TextCellEditor as never,
  number: NumberCellEditor as never,
  bool: BoolCellEditor as never,
  datetime: DatetimeEditor as never,
  money_rate: MoneyRateEditor as never,
};

/**
 * One parameter, shown as its value; clicking opens the design system's
 * editor for its type in place. A committed value goes to the kernel as is.
 */
function ParameterInput({
  name,
  value,
  context,
  disabled,
  onCommit,
}: {
  name: string;
  value: WorkRuleParameter;
  context: DataField | undefined;
  disabled: boolean;
  onCommit: (next: WorkRuleParameter) => void;
}) {
  const [editing, setEditing] = useState(false);
  const label = parameterName(name);
  if (value.type === "date")
    return (
      <span className="inline-flex align-middle" data-rule-parameter={name}>
        <DateField
          ariaLabel={label}
          disabled={disabled}
          value={value.value}
          onChange={(next) => {
            if (next && next !== value.value) onCommit({ type: "date", value: next });
          }}
        />
      </span>
    );
  const editor = editors[value.type];
  if (editing && editor !== undefined) {
    const ctx: EditorContext = {
      rowKey: { type: "record_id", value: name },
      fieldId: name,
      fieldType: {
        type: value.type,
        label,
        // The parameter's own currency is always offered, with the defaults.
        ...(value.type === "money_rate"
          ? { currencyOptions: [...new Set([value.value.currency, ...moneyRateDefaultCurrencies])] }
          : {}),
      },
    };
    const Editor = editor.Component;
    return (
      <span
        className="inline-flex rounded-[var(--radius-control)] border border-[var(--color-border-strong)] bg-[var(--color-bg-surface)] align-middle"
        data-rule-parameter={name}
      >
        <Editor
          context={ctx}
          initialValue={editor.parse(value as never, ctx)}
          onCancel={() => setEditing(false)}
          onCommit={(next) => {
            setEditing(false);
            onCommit(editor.serialize(next, ctx) as WorkRuleParameter);
          }}
        />
      </span>
    );
  }
  return (
    <button
      aria-label={`${label}: ${formatAs(value, context)}. Change`}
      className={cx(
        "inline-flex items-center rounded-[var(--radius-control)] border border-dashed border-[var(--color-action-primary)]",
        "bg-[var(--color-bg-selected)] px-[var(--space-1-5)] font-[var(--font-weight-medium)] tabular-nums text-[var(--color-action-primary-ink)]",
        "hover:border-solid disabled:cursor-not-allowed disabled:opacity-60",
        focusRing,
      )}
      data-rule-parameter={name}
      disabled={disabled}
      title={`${label} — click to change`}
      type="button"
      onClick={() => setEditing(true)}
    >
      {formatAs(value, context)}
    </button>
  );
}

export type RuleCardProps = {
  rule: CanvasRule;
  definition: DataDefinition;
  /** The session's rule operations; each re-reads the session, so staged values follow. */
  session: Pick<CanvasSession, "ruleParameters" | "ruleRemove">;
  /** Hears every outcome, e.g. for a toast. */
  onOutcome?: (outcome: CanvasOutcome, action: "parameters" | "remove") => void;
  /**
   * Inside a unit frame on the plane: no card border, and the frame's header
   * shows the title (`ruleTitle`).
   */
  inUnit?: boolean;
};

/** A rule's title: its description, else the header of the column it sets. */
export function ruleTitle(definition: DataDefinition, rule: CanvasRule): string {
  const labels = createLabelIndex(definition);
  const target = labels.fieldById(labels.modelById(rule.model_id), rule.field_id);
  return rule.description ?? (target === undefined ? "a removed column" : fieldHeader(target));
}

/**
 * One rule in plain words: the column it sets, the value and the condition,
 * by column header. Parameters are editable in place and re-stage live;
 * Remove asks once more, then removes the rule and the values it staged.
 */
export function RuleCard({ rule, definition, session, onOutcome, inUnit = false }: RuleCardProps) {
  const labels = useMemo(() => createLabelIndex(definition), [definition]);
  const model = labels.modelById(rule.model_id);
  const target = labels.fieldById(model, rule.field_id);
  const [busy, setBusy] = useState<"parameters" | "remove" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (action: "parameters" | "remove", request: () => Promise<CanvasOutcome>) => {
    setBusy(action);
    setFailure(null);
    const outcome = await request();
    setBusy(null);
    if (!outcome.ok) setFailure(outcome.message);
    onOutcome?.(outcome, action);
  };
  const words: Words = {
    labels,
    models: definition.models,
    model,
    parameter: (name) => {
      const value = rule.parameters?.[name];
      if (value === undefined)
        return (
          <span className="text-[var(--color-status-danger)]">{parameterName(name)} (missing)</span>
        );
      return (
        <ParameterInput
          context={target}
          disabled={busy !== null}
          name={name}
          value={value}
          onCommit={(next) =>
            void run("parameters", () =>
              session.ruleParameters(rule.id, { ...rule.parameters, [name]: next }),
            )
          }
        />
      );
    },
  };
  const header = target === undefined ? "a removed column" : fieldHeader(target);
  const modelName = model === undefined ? "record" : labels.modelLabel(model.id);
  const byAgent = rule.author_kind === "agent";

  return (
    <article
      aria-label={`Rule setting ${header}`}
      className={cx(
        "flex flex-col gap-[var(--space-2)] px-[var(--space-4)] py-[var(--space-3)]",
        !inUnit &&
          "rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
      )}
      data-rule={rule.id}
      data-rule-author={rule.author_kind}
    >
      <header className="flex items-start justify-between gap-[var(--space-3)]">
        {inUnit ? null : (
          <h3 className="m-[var(--space-0)] min-w-[var(--space-0)] text-[length:var(--text-control-md)] font-[var(--font-weight-semibold)] text-[var(--color-text-primary)]">
            {rule.description ?? header}
          </h3>
        )}
        <div
          className={cx(
            "flex shrink-0 items-center gap-[var(--space-2)]",
            inUnit && "w-full justify-between",
          )}
        >
          <Tag label={byAgent ? "By the agent" : "By you"} tone={byAgent ? "blue" : "gray"} />
          <ConfirmButton
            confirmLabel="Remove rule and its changes?"
            disabled={busy !== null}
            idleLabel="Remove"
            intent="ghost"
            loading={busy === "remove"}
            size="xs"
            onConfirm={() => void run("remove", () => session.ruleRemove(rule.id))}
          />
        </div>
      </header>
      <p
        className="m-[var(--space-0)] text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]"
        data-rule-words
      >
        Sets <Column>{header}</Column> to {say(words, rule.value, target)} for{" "}
        {rule.condition === undefined ? (
          <>every {modelName}</>
        ) : (
          <>
            each {modelName} where {say(words, rule.condition)}
          </>
        )}
        .
      </p>
      {failure === null ? null : (
        <p
          className="m-[var(--space-0)] text-[length:var(--text-caption)] text-[var(--color-status-danger)]"
          role="alert"
        >
          {failure}
        </p>
      )}
    </article>
  );
}
