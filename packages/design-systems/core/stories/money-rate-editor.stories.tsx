import { useEffect, useRef, useState, type ComponentType } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  Badge,
  Button,
  Card,
  MoneyRateEditor,
  type EditorContext,
  type EditorProps,
  type MoneyRateEditValue,
  type MoneyRateCommitValue,
} from "../components";

const editorContext: EditorContext = {
  rowKey: { type: "external_key", value: "row-staff-engineer" },
  fieldId: "compensation",
  fieldType: {
    type: "money_rate",
    label: "Compensation",
    currencyOptions: ["USD", "CAD", "EUR", "GBP"],
    periodOptions: ["hourly", "daily", "weekly", "monthly", "annual"],
  },
  asOf: "2026-09-01",
};

const meta = {
  title: "Design System/Editors/MoneyRateEditor",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[720px]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function makeInitial(
  amount: string,
  currency: string,
  period: MoneyRateEditValue["period"],
): MoneyRateEditValue {
  return { amount, currency, period, initialAmount: amount || "0" };
}

export const Default: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("", "USD", "annual")}
      helper="No initial value. Type a number, +5000, +5%, *1.1, or 165k. Enter or blur commits."
    />
  ),
};

export const WithAnnualUSD: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      helper="Annual USD baseline. Try +5% to see live preview at $157,500."
    />
  ),
};

export const WithMonthlyEUR: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("8000", "EUR", "monthly")}
      helper="Monthly EUR rate. Currency and period stay live during edits."
    />
  ),
};

export const MathExpressionPlus5Percent: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      initialQuery="+5%"
      helper="Pre-filled +5% expression resolves to $157,500 in the preview."
    />
  ),
};

export const MathExpressionShorthand: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("100000", "USD", "annual")}
      initialQuery="165k"
      helper="Shorthand 165k expands to $165,000."
    />
  ),
};

export const MathExpressionAddSubtract: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      initialQuery="+5000"
      helper="Relative add 5,000 yields $155,000."
    />
  ),
};

export const MathExpressionInvalid: Story = {
  render: () => (
    <MoneyRateHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      initialQuery="blah"
      helper="Invalid input shows danger preview. Enter and blur do not commit. Escape still cancels."
    />
  ),
};

export const CurrencyChangeOnly: Story = {
  render: () => (
    <CurrencySwitchHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      switchTo="EUR"
      helper="Story switches the currency dropdown without changing the amount, then commits via Enter."
    />
  ),
};

export const PeriodChangeOnly: Story = {
  render: () => (
    <PeriodSwitchHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      switchTo="monthly"
      helper="Story switches the period dropdown without changing the amount, then commits via Enter."
    />
  ),
};

export const EmptyExitsAsNoop: Story = {
  render: () => (
    <BlurEmptyHarness
      initialValue={makeInitial("", "USD", "annual")}
      helper="Empty initial value with no edits. Blur fires onCancel; no commit is recorded."
    />
  ),
};

export const TabNavigation: Story = {
  render: () => (
    <TabHarness
      initialValue={makeInitial("150000", "USD", "annual")}
      initialQuery="+1000"
      helper="Story dispatches Tab to commit and request next-cell focus."
    />
  ),
};

type Receipt = MoneyRateCommitValue | null;

type HarnessBaseProps = {
  initialValue: MoneyRateEditValue;
  initialQuery?: string;
  helper?: string;
};

const Editor = MoneyRateEditor.Component as ComponentType<
  EditorProps<MoneyRateEditValue, MoneyRateCommitValue> & { initialQuery?: string }
>;

function MoneyRateHarness(props: HarnessBaseProps) {
  const [lastCommit, setLastCommit] = useState<Receipt>(null);
  const [cancelCount, setCancelCount] = useState(0);
  const [navigation, setNavigation] = useState<"next" | "previous" | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [active, setActive] = useState(true);

  function reset() {
    setLastCommit(null);
    setCancelCount(0);
    setNavigation(null);
    setActive(true);
    setResetKey((current) => current + 1);
  }

  return (
    <Card
      title="Money Rate Editor"
      actions={
        <Button size="sm" intent="secondary" onClick={reset}>
          Reset Editor
        </Button>
      }
    >
      <div className="grid gap-[var(--space-4)]">
        {/* Wrapping div mimics the popover surface a real consumer (AG Grid
            popup) provides. The atom itself carries no border / shadow. */}
        <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] shadow-[var(--shadow-raised)]">
          {active ? (
            <Editor
              key={resetKey}
              initialValue={props.initialValue}
              initialQuery={props.initialQuery}
              context={editorContext}
              onCommit={(next) => {
                setLastCommit(next);
                setActive(false);
              }}
              onCancel={() => {
                setCancelCount((current) => current + 1);
                setActive(false);
              }}
              onNavigate={(direction) => {
                setNavigation(direction);
                setActive(false);
              }}
            />
          ) : (
            <div className="rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
              Editor closed. Reset to edit again.
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-[var(--space-2)]">
          <Badge tone={lastCommit ? "success" : "neutral"}>
            Commit:{" "}
            {lastCommit
              ? `${lastCommit.amount} ${lastCommit.currency}/${lastCommit.period}`
              : "none"}
          </Badge>
          <Badge tone={cancelCount ? "warning" : "neutral"}>Cancels: {cancelCount}</Badge>
          <Badge tone={navigation ? "info" : "neutral"}>Navigate: {navigation ?? "none"}</Badge>
        </div>
        <p className="m-0 text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
          {props.helper ??
            "Enter or blur commits, Escape cancels, Tab commits and requests focus on the next cell."}
        </p>
      </div>
    </Card>
  );
}

function setSelectValueReact(select: HTMLSelectElement, value: string) {
  // React 19 ignores direct .value writes on controlled selects; bypass the value tracker.
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter) {
    setter.call(select, value);
  } else {
    select.value = value;
  }
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function dispatchEnter(target: HTMLElement) {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

function CurrencySwitchHarness(props: HarnessBaseProps & { switchTo: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const select = containerRef.current?.querySelector<HTMLSelectElement>("select");
      const input = containerRef.current?.querySelector<HTMLInputElement>("input");
      if (select) {
        select.focus();
        setSelectValueReact(select, props.switchTo);
      }
      if (input) {
        input.focus();
        dispatchEnter(input);
      }
    }, 50);
    return () => window.clearTimeout(handle);
  }, [props.switchTo]);
  return (
    <div ref={containerRef}>
      <MoneyRateHarness {...props} />
    </div>
  );
}

function PeriodSwitchHarness(props: HarnessBaseProps & { switchTo: MoneyRateEditValue["period"] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const selects = containerRef.current?.querySelectorAll<HTMLSelectElement>("select");
      const periodSelect = selects ? selects[selects.length - 1] : null;
      const input = containerRef.current?.querySelector<HTMLInputElement>("input");
      if (periodSelect) {
        periodSelect.focus();
        setSelectValueReact(periodSelect, props.switchTo);
      }
      if (input) {
        input.focus();
        dispatchEnter(input);
      }
    }, 50);
    return () => window.clearTimeout(handle);
  }, [props.switchTo]);
  return (
    <div ref={containerRef}>
      <MoneyRateHarness {...props} />
    </div>
  );
}

function BlurEmptyHarness(props: HarnessBaseProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const input = containerRef.current?.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.blur();
    }, 50);
    return () => window.clearTimeout(handle);
  }, []);
  return (
    <div ref={containerRef}>
      <MoneyRateHarness {...props} />
    </div>
  );
}

function TabHarness(props: HarnessBaseProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const input = containerRef.current?.querySelector<HTMLInputElement>("input");
      if (input) {
        input.focus();
        const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
        input.dispatchEvent(event);
      }
    }, 50);
    return () => window.clearTimeout(handle);
  }, []);
  return (
    <div ref={containerRef}>
      <MoneyRateHarness {...props} />
    </div>
  );
}
