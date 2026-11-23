// SourceArtifactDropZone stories — visual verification of the generic file
// intake surface against the canonical empty-state mock
// (`docs/mocks/csv-import/empty-state.html`).
//
// Stories cover the four user-visible states (idle, drag-over, loading,
// errored) plus an optional `footerNote` slot. Drag-over and loading states
// are driven by directly toggling the component's `data-state` attribute via
// the DOM since they're transient interaction states — easier to eyeball
// than to script with `userEvent.dragEnter`.
//
// `onArtifact` / `onError` are stubbed so stories never read real files;
// stories that surface error states call the same DOM hooks the picker
// uses (`change` event on the hidden input) with synthetic File instances.

import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import { SourceArtifactDropZone } from "./SourceArtifactDropZone";

const meta = {
  title: "Source Import / SourceArtifactDropZone",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 720,
          padding: "var(--space-6)",
          background: "var(--color-bg-page)",
          fontFamily: "var(--font-sans)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// Most visual states are driven by `data-state` on the inner zone element;
// the stories below imperatively set that attribute via a ref after mount to
// render the state without triggering real drag/drop or file-read code.
function StateOverride(props: {
  state: "idle" | "drag-over" | "loading" | "error";
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current?.querySelector(".source-artifact-drop-zone") as HTMLElement | null;
    if (node) node.setAttribute("data-state", props.state);
  }, [props.state]);
  return <div ref={ref}>{props.children}</div>;
}

export const Idle: Story = {
  render: () => (
    <SourceArtifactDropZone
      onArtifact={() => {}}
      onError={() => {}}
      headline="Drop a CSV here"
      subline="Or click to choose a file from your computer."
      ctaLabel="Choose file"
    />
  ),
};

export const DragOver: Story = {
  render: () => (
    <StateOverride state="drag-over">
      <SourceArtifactDropZone
        onArtifact={() => {}}
        onError={() => {}}
        headline="Drop a CSV here"
        subline="Or click to choose a file from your computer."
      />
    </StateOverride>
  ),
};

function LoadingHarness() {
  // Inject a file via the hidden picker; intercept the file's arrayBuffer()
  // with a never-resolving promise so the React `state === "loading"` branch
  // renders ("Reading file..." copy + cursor: progress) without ever
  // emitting an artifact. Story-only seam — production reads complete.
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = wrapperRef.current?.querySelector("input[type=file]") as HTMLInputElement | null;
    if (!input) return;
    const file = new File([new Uint8Array(0)], "loading.csv", { type: "text/csv" });
    Object.defineProperty(file, "size", { value: 1024, configurable: true });
    Object.defineProperty(file, "arrayBuffer", {
      value: () => new Promise(() => {}),
      configurable: true,
    });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, []);
  return (
    <div ref={wrapperRef}>
      <SourceArtifactDropZone
        onArtifact={() => {}}
        onError={() => {}}
        headline="Drop a CSV here"
        subline="Or click to choose a file from your computer."
      />
    </div>
  );
}

export const Loading: Story = {
  render: () => <LoadingHarness />,
};

function ErrorHarness(props: { kind: "too_large" | "unsupported_content_type" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input[type=file]") as HTMLInputElement | null;
    if (!input) return;
    // Fabricate a file that violates one of the configured constraints so
    // the component renders its real error state instead of one we paint
    // in CSS. The visible alert text comes from the component itself.
    let file: File;
    if (props.kind === "too_large") {
      file = new File([new Uint8Array(0)], "oversized.csv", { type: "text/csv" });
      Object.defineProperty(file, "size", { value: 5_000_000, configurable: true });
    } else {
      file = new File([new Uint8Array(0)], "notes.pdf", { type: "application/pdf" });
      Object.defineProperty(file, "size", { value: 1024, configurable: true });
    }
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    input.files = dataTransfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [props.kind]);

  const commonProps = {
    onArtifact: () => {},
    onError: () => {},
    headline: "Drop a CSV here",
    subline: "Or click to choose a file from your computer.",
  } as const;

  if (props.kind === "too_large") {
    return (
      <div ref={ref}>
        <SourceArtifactDropZone {...commonProps} maxBytes={100} />
      </div>
    );
  }
  return (
    <div ref={ref}>
      <SourceArtifactDropZone {...commonProps} acceptedContentTypes={["text/csv"]} />
    </div>
  );
}

export const Error_TooLarge: Story = {
  render: () => <ErrorHarness kind="too_large" />,
};

export const Error_UnsupportedType: Story = {
  render: () => <ErrorHarness kind="unsupported_content_type" />,
};

export const WithFooterNote: Story = {
  render: () => (
    <SourceArtifactDropZone
      onArtifact={() => {}}
      onError={() => {}}
      headline="Drop a CSV here"
      subline="Or click to choose a file from your computer."
      footerNote={<span>CSV import agent · won't write anything until you save</span>}
    />
  ),
};
