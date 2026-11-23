// BulkUpdateTrigger stories — toolbar segment that pairs with
// `controller.stageBulkUpdate`. Each story renders the trigger in isolation
// against a synthetic items list so the leaf can be verified before being
// assembled into the PositionsPage toolbar (per components-up sequencing).
//
// The component owns its own open/close state, so the "open" story can't be
// declarative — it relies on the user clicking the trigger inside the
// canvas. A `preopened` harness drives the menu open via a useEffect so
// the screenshot captures the dropdown body for layout review.

import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { BulkUpdateTrigger, type BulkUpdatePickerItem } from "./bulk-update-trigger";

// Generic items — the module is shared infrastructure, so the story must
// stay app-domain-free. Apps thread their schema's change-types in at
// the call site. Story copy uses placeholder verbs so the visual stays
// representative without leaking any specific app's vocabulary.
const ITEMS: BulkUpdatePickerItem[] = [
  { id: "verb_alpha", label: "Verb alpha", touchLabels: "Field one · Field two · Field three" },
  { id: "verb_beta", label: "Verb beta", touchLabels: "Field two · Field four" },
  { id: "verb_gamma", label: "Verb gamma", touchLabels: "Field five" },
  {
    id: "verb_delta",
    label: "Verb delta",
    touchLabels: "Field one · Field two · Field three · Field four",
  },
];

const meta = {
  title: "Editable Grid/Chrome/BulkUpdateTrigger",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const ClosedSingleSelected: Story = {
  render: () => (
    <BulkUpdateTrigger selectedCount={1} items={ITEMS} onPick={noop} onClearSelection={noop} />
  ),
};

export const ClosedMultiSelected: Story = {
  render: () => (
    <BulkUpdateTrigger selectedCount={5} items={ITEMS} onPick={noop} onClearSelection={noop} />
  ),
};

// Programmatically opens the dropdown by simulating a click on the trigger
// once the component mounts. The trigger owns its open state internally
// (per the layer rule); a harness like this is the only way to surface the
// "open" presentation in a screenshot.
function OpenHarness() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const btn = hostRef.current?.querySelector<HTMLButtonElement>("[data-bulk-update-trigger]");
    btn?.click();
  }, []);
  return (
    <div ref={hostRef}>
      <BulkUpdateTrigger selectedCount={3} items={ITEMS} onPick={noop} onClearSelection={noop} />
    </div>
  );
}

export const Open: Story = {
  render: () => <OpenHarness />,
};

export const Disabled: Story = {
  render: () => (
    <BulkUpdateTrigger
      selectedCount={2}
      items={ITEMS}
      onPick={noop}
      onClearSelection={noop}
      disabled
    />
  ),
};
