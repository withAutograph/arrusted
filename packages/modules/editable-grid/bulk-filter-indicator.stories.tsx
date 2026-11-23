// BulkFilterIndicator stories — yellow strip above the grid when a
// `controller.activeBulkFilter` is set.
//
// States covered:
//   Closed                  – just the strip, no popover
//   RenamePopoverOpen       – Rename group popover auto-opened via harness
//   ChangeDatePopoverOpen   – Change date for group popover auto-opened
//
// The popovers are body-portaled by the underlying `BodyPortalPopover`, so
// the canvas needs vertical room for the panel to render below the strip
// without clipping at the viewport top.

import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { BulkFilterIndicator } from "./bulk-filter-indicator";

const noop = () => {};

const meta = {
  title: "Editable Grid/Chrome/BulkFilterIndicator",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] text-[var(--color-text-primary)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {
  render: () => (
    <BulkFilterIndicator
      rowCount={5}
      totalRows={27}
      groupName="Q3 reorg batch"
      recordNoun="positions"
      onRename={noop}
      onChangeDate={noop}
      onRevertAll={noop}
      onClear={noop}
    />
  ),
};

function OpenHarness(props: { triggerSelector: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const btn = hostRef.current?.querySelector<HTMLButtonElement>(props.triggerSelector);
    btn?.click();
  }, [props.triggerSelector]);
  return (
    <div ref={hostRef}>
      <BulkFilterIndicator
        rowCount={5}
        totalRows={27}
        groupName="Q3 reorg batch"
        recordNoun="positions"
        onRename={noop}
        onChangeDate={noop}
        onRevertAll={noop}
        onClear={noop}
      />
    </div>
  );
}

export const RenamePopoverOpen: Story = {
  render: () => <OpenHarness triggerSelector="[data-bulk-rename-trigger]" />,
};

export const ChangeDatePopoverOpen: Story = {
  render: () => <OpenHarness triggerSelector="[data-bulk-change-date-trigger]" />,
};
