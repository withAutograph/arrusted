import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button, Toast, ToastProvider, useToast } from "../components";

const meta = {
  title: "Design System/Overlays/Toast",
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

// Static gallery — render each variant side-by-side so the visual ID is
// reviewable in one frame. No provider, no auto-dismiss; the bar tint +
// content are what matters here.
function GalleryRow(props: { children: React.ReactNode; label: string }) {
  return (
    <div className="grid gap-[var(--space-2)]">
      <p className="m-0 text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-label)] text-[var(--color-text-muted)]">
        {props.label}
      </p>
      {props.children}
    </div>
  );
}

export const Variants: Story = {
  render: () => (
    <div className="grid gap-[var(--space-4)]">
      <GalleryRow label="Success — clean save">
        <Toast variant="success" message="Saved 3 changes" onDismiss={() => {}} />
      </GalleryRow>
      <GalleryRow label="Warning — partial save">
        <Toast
          variant="warning"
          message="Saved 1 change · 1 failed (Title change)"
          onDismiss={() => {}}
        />
      </GalleryRow>
      <GalleryRow label="Error — full failure">
        <Toast
          variant="error"
          message="Could not save 1 change · Title change — Senior engineer already has a change effective on 2026-07-15"
          onDismiss={() => {}}
        />
      </GalleryRow>
      <GalleryRow label="Info">
        <Toast variant="info" message="Schema refreshed" onDismiss={() => {}} />
      </GalleryRow>
      <GalleryRow label="With action button (undo slot)">
        <Toast
          variant="info"
          message="Discarded 'Close 3 Q1 positions'"
          action={{ label: "Undo", onClick: () => {} }}
          onDismiss={() => {}}
        />
      </GalleryRow>
    </div>
  ),
};

// Live harness — wraps a tiny page with the provider, lets the reviewer
// click each button to fire the corresponding toast. Auto-dismiss is on
// (8s default); the dismiss "X" works; the action button (Undo) demos
// the future approvals-page use case.
function LiveHarness() {
  const toast = useToast();
  const [lastAction, setLastAction] = useState("");
  return (
    <div className="grid gap-[var(--space-3)]">
      <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
        Click each button to fire a toast. They auto-dismiss after 8s; click the X to dismiss early;
        hover to pause the timer. Newer toasts stack at the bottom of the right corner.
      </p>
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <Button intent="secondary" onClick={() => toast.success("Saved 3 changes")}>
          Fire success
        </Button>
        <Button
          intent="secondary"
          onClick={() => toast.warning("Saved 1 change · 1 failed (Title change)")}
        >
          Fire warning
        </Button>
        <Button
          intent="secondary"
          onClick={() =>
            toast.error(
              "Could not save 1 change · Title change — Senior engineer already has a change effective on 2026-07-15",
            )
          }
        >
          Fire error
        </Button>
        <Button
          intent="secondary"
          onClick={() =>
            toast.info("Discarded 'Close 3 Q1 positions'", {
              action: {
                label: "Undo",
                onClick: () => setLastAction("undo-clicked"),
              },
            })
          }
        >
          Fire undo
        </Button>
      </div>
      <span className="text-[length:var(--text-caption)] text-[var(--color-text-muted)]">
        Last action: {lastAction || "(none)"}
      </span>
    </div>
  );
}

export const Live: Story = {
  render: () => (
    <ToastProvider>
      <LiveHarness />
    </ToastProvider>
  ),
};
