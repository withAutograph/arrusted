import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  AsOfDatePill,
  Button,
  FieldFrame,
  Modal,
  Sheet,
  SheetProvider,
  SheetRenderer,
  TextField,
  useSheet,
} from "../components";

const meta = {
  title: "Design System/Overlays/Sheet",
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

// Stripped-down record-table preview, sized to feel like the dev sandbox. Not
// functional — just visually convincing as the surface a sheet would float over.
function PageBehind() {
  const [asOf, setAsOf] = useState("2026-07-15");
  const rows = [
    { ext: "emp-001", name: "Sam Carter", title: "Senior engineer", rate: "$185,000 / yr" },
    { ext: "emp-002", name: "Priya Raman", title: "Staff engineer", rate: "$215,000 / yr" },
    { ext: "emp-003", name: "Alex Chen", title: "Engineering manager", rate: "$245,000 / yr" },
    { ext: "emp-004", name: "Jordan Lee", title: "Product designer", rate: "$165,000 / yr" },
    { ext: "emp-005", name: "Mei Tanaka", title: "Data scientist", rate: "$175,000 / yr" },
  ];
  return (
    <div className="grid gap-[var(--space-4)]">
      <div>
        <p className="m-0 text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-label)] text-[var(--color-text-muted)]">
          example model
        </p>
        <h1 className="m-0 text-[length:var(--text-page-title)]">Records</h1>
      </div>
      <div className="rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
        <div className="flex items-center justify-between gap-[var(--space-3)] border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)]">
          <div className="flex items-center gap-[var(--space-2)]">
            <AsOfDatePill value={asOf} onValueChange={setAsOf} />
          </div>
          <div className="flex items-center gap-[var(--space-2)]">
            <Button intent="secondary" size="sm">
              Export
            </Button>
            <Button intent="primary" size="sm">
              New record
            </Button>
          </div>
        </div>
        <div
          role="table"
          className="grid grid-cols-[120px_minmax(0,1fr)_minmax(0,1.2fr)_180px] text-[length:var(--text-control-sm)]"
        >
          <div
            role="row"
            className="contents text-[length:var(--text-caption)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-label)] text-[var(--color-text-muted)]"
          >
            {["External key", "Name", "Title", "Pay rate"].map((label) => (
              <div
                key={label}
                role="columnheader"
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-2-5)]"
              >
                {label}
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <div role="row" className="contents" key={row.ext}>
              <div
                role="cell"
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)] tabular-nums text-[var(--color-text-secondary)]"
              >
                {row.ext}
              </div>
              <div
                role="cell"
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--color-text-primary)]"
              >
                {row.name}
              </div>
              <div
                role="cell"
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--color-text-secondary)]"
              >
                {row.title}
              </div>
              <div
                role="cell"
                className="border-b border-[var(--color-border-subtle)] px-[var(--space-4)] py-[var(--space-3)] tabular-nums text-[var(--color-text-secondary)]"
              >
                {row.rate}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet open title="Edit record" onClose={() => {}}>
        <div className="grid gap-[var(--space-4)]">
          <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            Body content goes here. Sheet is a slot-based floating panel: header (title + close),
            body (scroll), and an optional footer.
          </p>
          <FieldFrame label="Name">
            <TextField defaultValue="Example value" />
          </FieldFrame>
          <FieldFrame label="Notes">
            <TextField defaultValue="" placeholder="Tab to focus" />
          </FieldFrame>
        </div>
      </Sheet>
    </>
  ),
};

export const WithFooter: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet
        open
        title="Edit record"
        onClose={() => {}}
        footer={
          <div className="flex flex-wrap justify-end gap-[var(--space-2)]">
            <Button intent="secondary">Save draft</Button>
            <Button intent="primary">Apply</Button>
          </div>
        }
      >
        <div className="grid gap-[var(--space-3)]">
          <FieldFrame label="External key">
            <TextField defaultValue="emp-001" />
          </FieldFrame>
          <FieldFrame label="Effective start">
            <TextField type="date" defaultValue="2026-07-15" />
          </FieldFrame>
          <FieldFrame label="Title">
            <TextField defaultValue="Senior engineer" />
          </FieldFrame>
        </div>
      </Sheet>
    </>
  ),
};

export const Backdrop: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet open backdrop title="Confirm action" onClose={() => {}}>
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          With <code>backdrop</code>, the page dims behind the sheet and clicking the dim layer
          closes it. Use sparingly &mdash; default is off so the page stays interactive.
        </p>
      </Sheet>
    </>
  ),
};

export const Wide: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet open title="Wide sheet" width="720px" onClose={() => {}}>
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          Pass <code>width</code> to override <code>--size-sheet-width</code> per open. Useful for
          deep-dive editors with multiple columns.
        </p>
      </Sheet>
    </>
  ),
};

export const Edge: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet open placement="edge" eyebrow="Employee" title="Sam Carter" onClose={() => {}}>
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          With <code>placement=&quot;edge&quot;</code>, the sheet sits flush against the right edge
          from <code>top</code> to the bottom, behind a single hairline. An <code>eyebrow</code>{" "}
          names what the title is.
        </p>
      </Sheet>
    </>
  ),
};

function ManagerHarness() {
  const { openSheet, closeSheet, isOpen } = useSheet();
  const [savedName, setSavedName] = useState("");
  return (
    <div className="grid gap-[var(--space-3)]">
      <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
        SheetProvider holds exactly one open sheet. <code>openSheet</code> replaces;{" "}
        <code>closeSheet</code> awaits any per-open <code>onBeforeClose</code>.
      </p>
      <div className="flex flex-wrap gap-[var(--space-2)]">
        <Button
          intent="primary"
          onClick={() =>
            openSheet({
              title: "Edit record",
              content: <ManagerSheetContent onSave={setSavedName} closeSheet={closeSheet} />,
            })
          }
        >
          Open sheet
        </Button>
        <span className="text-[length:var(--text-body)] text-[var(--color-text-muted)]">
          Open: {String(isOpen)} &middot; Last saved: {savedName || "(none)"}
        </span>
      </div>
    </div>
  );
}

function ManagerSheetContent(props: {
  onSave: (name: string) => void;
  closeSheet: (reason?: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  return (
    <div className="grid gap-[var(--space-3)]">
      <FieldFrame label="Name">
        <TextField value={name} onValueChange={setName} placeholder="Type something" />
      </FieldFrame>
      <div className="flex justify-end gap-[var(--space-2)]">
        <Button intent="secondary" onClick={() => void props.closeSheet("cancel")}>
          Cancel
        </Button>
        <Button
          intent="primary"
          onClick={() => {
            props.onSave(name);
            void props.closeSheet("save");
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export const Manager: Story = {
  render: () => (
    <SheetProvider>
      <ManagerHarness />
      <SheetRenderer />
    </SheetProvider>
  ),
};

// Regression harness for the "openSheet pre-clears dirty before manager guard"
// bug (C1). Opens a "dirty editor" sheet, then clicking "Open another record"
// calls openSheet({...}) again — the manager invokes the prior payload's
// onBeforeClose("replaced"), which sees dirty=true and shows the discard
// prompt. Before the App.tsx fix, the host pre-cleared its dirty flag right
// before openSheet, so the guard saw dirty=false and silently discarded the
// outgoing editor. Here we reproduce the manager-level intercept directly so
// the visual proof doesn't depend on the dev app's substrate.
function ReplaceDirtySheetHarness() {
  const { openSheet } = useSheet();
  const [dirty, setDirty] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resolver, setResolver] = useState<((allow: boolean) => void) | null>(null);

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const openEditor = (label: string) => {
    void openSheet({
      title: `Edit ${label}`,
      onBeforeClose: () => {
        if (!dirtyRef.current) return true;
        return new Promise<boolean>((resolve) => {
          setResolver(() => resolve);
          setConfirmOpen(true);
        });
      },
      content: (
        <div className="grid gap-[var(--space-3)]">
          <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            Editing <strong>{label}</strong>. Mark this dirty, then open another record to trigger
            the replace path.
          </p>
          <FieldFrame label="Name">
            <TextField defaultValue={label} onValueChange={() => setDirty(true)} />
          </FieldFrame>
        </div>
      ),
    });
  };

  return (
    <div className="grid gap-[var(--space-3)]">
      <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
        Step 1: open editor A. Step 2: edit a field (host marks dirty). Step 3: open editor B — the
        manager intercepts the replace and the discard prompt fires.
      </p>
      <div className="flex gap-[var(--space-2)]">
        <Button intent="primary" onClick={() => openEditor("emp-001")}>
          Open editor A
        </Button>
        <Button intent="primary" onClick={() => openEditor("emp-002")}>
          Open editor B
        </Button>
        <span className="self-center text-[length:var(--text-body)] text-[var(--color-text-muted)]">
          Dirty: {String(dirty)}
        </span>
      </div>
      <Modal
        open={confirmOpen}
        size="sm"
        title="Discard changes?"
        onClose={() => {
          resolver?.(false);
          setConfirmOpen(false);
          setResolver(null);
        }}
        actions={
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button
              intent="secondary"
              onClick={() => {
                resolver?.(false);
                setConfirmOpen(false);
                setResolver(null);
              }}
            >
              Cancel
            </Button>
            <Button
              intent="danger"
              onClick={() => {
                // Mirror the App.tsx ConfirmDiscardDialog pattern: resolve the
                // pending onBeforeClose promise only. The awaiting openSheet
                // path owns the actual close-and-replace; calling closeSheet
                // here would re-fire onBeforeClose against still-true dirty
                // state and require a second Discard click.
                setDirty(false);
                resolver?.(true);
                setConfirmOpen(false);
                setResolver(null);
              }}
            >
              Discard
            </Button>
          </div>
        }
      >
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          You have unsaved changes. Discarding will lose them.
        </p>
      </Modal>
    </div>
  );
}

export const ReplaceDirtySheet: Story = {
  render: () => (
    <SheetProvider>
      <ReplaceDirtySheetHarness />
      <SheetRenderer />
    </SheetProvider>
  ),
};

// Regression harness for the "focus restoration triggered by onClose identity"
// bug. Parent re-renders every 200ms and passes a fresh inline arrow into
// `onClose`. With the old effect (deps include `onClose`), every re-render
// would tear down and re-run the focus-capture/restore cleanup, snapping focus
// back to the previously-active element. With the fix (onClose mirrored into a
// ref; effect deps `[open]` only), focus stays in the input across renders.
function UnstableOnCloseHarness() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((value) => value + 1), 200);
    return () => clearInterval(id);
  }, []);
  return (
    <>
      <PageBehind />
      <Sheet
        open
        title={`Edit record (parent re-render ${tick})`}
        onClose={() => {
          /* fresh identity every parent render */
        }}
      >
        <div className="grid gap-[var(--space-4)]">
          <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
            Click the input below and start typing. Parent re-renders every 200ms with a fresh
            <code> onClose</code> arrow. After the H2 fix the input keeps focus and your text keeps
            arriving; before the fix focus would snap back to the page on every render.
          </p>
          <FieldFrame label="Type here">
            <TextField defaultValue="" placeholder="Focus me, then watch the tick" />
          </FieldFrame>
        </div>
      </Sheet>
    </>
  );
}

export const UnstableOnClose: Story = {
  render: () => <UnstableOnCloseHarness />,
};

export const DiscardConfirmOverSheet: Story = {
  render: () => (
    <>
      <PageBehind />
      <Sheet open title="Edit record" onClose={() => {}}>
        <div className="grid gap-[var(--space-4)]">
          <FieldFrame label="Name">
            <TextField defaultValue="Sam Carter (edited)" />
          </FieldFrame>
          <FieldFrame label="Notes">
            <TextField defaultValue="Pending review" />
          </FieldFrame>
        </div>
      </Sheet>
      <Modal
        open
        size="sm"
        title="Discard changes?"
        onClose={() => {}}
        actions={
          <div className="flex justify-end gap-[var(--space-2)]">
            <Button intent="secondary">Cancel</Button>
            <Button intent="danger">Discard</Button>
          </div>
        }
      >
        <p className="m-0 text-[length:var(--text-body)] text-[var(--color-text-secondary)]">
          You have unsaved changes. Discarding will lose them.
        </p>
      </Modal>
    </>
  ),
};
