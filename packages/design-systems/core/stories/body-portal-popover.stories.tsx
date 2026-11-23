/*
 * BodyPortalPopover — body-portaled popover anchored against an external
 * trigger ref. The panel escapes the trigger's parent overflow context
 * (e.g., a scrollable table viewport) and re-anchors on scroll/resize.
 *
 * Stories cover the open + closed states and a click-outside dismiss
 * demonstration.
 */
import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { BodyPortalPopover, Button, Card, TextField } from "../components";

const meta = {
  title: "Design System/Overlays/BodyPortalPopover",
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-[var(--color-bg-page)] p-[var(--space-6)] text-[var(--color-text-primary)]">
        <div className="mx-auto max-w-[var(--size-modal-md)]">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Trigger uses a plain <button> with a chrome that matches the production
// BulkFilterIndicator's pill cluster — the popover is the focus of the story.
const triggerClass =
  "inline-flex items-center rounded-[var(--radius-xs)] border border-[var(--color-border-strong)] " +
  "bg-[var(--color-bg-surface)] px-[var(--space-2)] py-[var(--space-0-5)] " +
  "text-[length:var(--text-micro)] text-[var(--color-text-primary)] cursor-pointer";

function ClosedHarness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <Card title="BodyPortalPopover — closed">
      <div className="flex items-center justify-end">
        <button
          ref={triggerRef}
          type="button"
          className={triggerClass}
          onClick={() => setOpen((current) => !current)}
        >
          Open popover
        </button>
      </div>
      <BodyPortalPopover
        open={open}
        anchorRef={triggerRef}
        ariaLabel="Sample popover"
        onClose={() => setOpen(false)}
      >
        <div className="p-[var(--space-3)]" style={{ minWidth: "var(--size-popover-min-width)" }}>
          <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            Click outside or press Escape to dismiss.
          </p>
        </div>
      </BodyPortalPopover>
    </Card>
  );
}

function OpenHarness() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState("Q3 reorg batch");
  return (
    <Card title="BodyPortalPopover — open (Rename pattern)">
      <div className="flex items-center justify-end">
        <button ref={triggerRef} type="button" className={triggerClass}>
          Rename group
        </button>
      </div>
      <BodyPortalPopover
        open
        anchorRef={triggerRef}
        ariaLabel="Rename bulk group"
        onClose={() => null}
      >
        <form
          className="flex flex-col gap-[var(--space-2)] p-[var(--space-3)]"
          style={{ minWidth: "var(--size-popover-min-width)" }}
          onSubmit={(event) => event.preventDefault()}
        >
          <TextField aria-label="Bulk group name" size="sm" value={name} onValueChange={setName} />
          <div className="flex items-center justify-end gap-[var(--space-2)]">
            <Button intent="secondary" size="sm">
              Cancel
            </Button>
            <Button intent="primary" size="sm" type="submit">
              Save
            </Button>
          </div>
        </form>
      </BodyPortalPopover>
    </Card>
  );
}

export const Closed: Story = {
  render: () => <ClosedHarness />,
};

export const OpenWithForm: Story = {
  render: () => <OpenHarness />,
};
