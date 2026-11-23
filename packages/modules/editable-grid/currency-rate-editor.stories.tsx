import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { CurrencyRateEditor, type CurrencyRateEditorProps } from "./CurrencyRateEditor";

const periods: CurrencyRateEditorProps["rates"] = [
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.095",
    effectiveStart: "2026-10-01",
    effectiveEnd: null,
    origin: "custom",
  },
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.08",
    effectiveStart: "2026-09-01",
    effectiveEnd: "2026-09-20",
    origin: "custom",
  },
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.1024",
    effectiveStart: "2026-10-01",
    effectiveEnd: null,
    origin: "frankfurter",
    observationDate: "2026-10-01",
  },
  {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.0982",
    effectiveStart: "2026-09-01",
    effectiveEnd: "2026-09-30",
    origin: "frankfurter",
    observationDate: "2026-09-01",
  },
];

function dayBefore(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// In-memory interaction fixture only. Hosts persist through createCurrencyRateStore.
function Example(props: CurrencyRateEditorProps) {
  const [rates, setRates] = useState(props.rates);
  function replaceFrom(start: string, next?: CurrencyRateEditorProps["rates"][number]) {
    setRates((previous) => {
      const following = previous
        .filter((row) => row.origin === "custom" && row.effectiveStart > start)
        .toSorted((a, b) => a.effectiveStart.localeCompare(b.effectiveStart))[0];
      const result = previous
        .filter((row) => row.origin !== "custom" || row.effectiveStart !== start)
        .map((row) =>
          row.origin === "custom" &&
          row.effectiveStart < start &&
          (!row.effectiveEnd || row.effectiveEnd >= start)
            ? { ...row, effectiveEnd: dayBefore(start) }
            : row,
        );
      if (next)
        result.push({
          ...next,
          effectiveEnd:
            following && (!next.effectiveEnd || next.effectiveEnd >= following.effectiveStart)
              ? dayBefore(following.effectiveStart)
              : next.effectiveEnd,
        });
      return result;
    });
  }
  return (
    <CurrencyRateEditor
      {...props}
      rates={rates}
      onSave={async (input) => {
        await props.onSave(input);
        replaceFrom(input.effectiveStart, {
          ...input,
          origin: "custom",
        });
      }}
      onUseAutomatic={async (input) => {
        await props.onUseAutomatic(input);
        replaceFrom(input.effectiveStart);
      }}
    />
  );
}

const meta = {
  title: "Design System/CurrencyRateEditor",
  component: CurrencyRateEditor,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-4)] sm:p-[var(--space-8)]">
        <div className="mx-auto max-w-[1200px]">
          <Story />
        </div>
      </div>
    ),
  ],
  render: (args) => <Example {...args} />,
  args: {
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rates: periods,
    onSave: async () => {},
    onUseAutomatic: async () => {},
  },
} satisfies Meta<typeof CurrencyRateEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {};
export const AutomaticOnly: Story = {
  args: { rates: periods.filter((row) => row.origin === "frankfurter") },
};
export const Empty: Story = { args: { rates: [] } };
export const SaveFailure: Story = {
  args: {
    onSave: async () => {
      throw new Error("Could not save. Please try again.");
    },
  },
};
