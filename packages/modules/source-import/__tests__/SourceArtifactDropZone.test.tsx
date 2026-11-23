// Tests for the SourceArtifactDropZone composite.
//
// Covers the four contract-shaped behaviors:
// 1. The component renders without crashing and exposes the hidden file input.
// 2. A picker-driven file submission emits `onArtifact` with SourceArtifact
//    metadata plus the original file and bytes.
// 3. A too-large file fires `onError({ kind: "too_large", ... })` and does
//    not fire `onArtifact`.
// 4. A file with an unsupported content type fires `onError({ kind:
//    "unsupported_content_type", ... })` and does not fire `onArtifact`.
//
// The hash computation is stubbed so the test is deterministic and does not
// depend on jsdom's `crypto.subtle` availability.

import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Import directly from the component module rather than through the
// `@source-import` barrel. Sibling composites in the module (e.g. the
// staged accordion shell) are landed in parallel, and the barrel may
// transiently re-export shapes whose source files have not yet landed.
// Direct-from-source imports keep this test stable while sibling subagent
// work is in flight.
import {
  SourceArtifactDropZone,
  type SourceArtifactError,
  type SourceArtifactSelection,
} from "../components/SourceArtifactDropZone";

function makeStubbedDigest(): ArrayBuffer {
  // 32 bytes of 0xab so the resulting hex string is well-formed and easy to
  // spot in a failed assertion.
  const buffer = new ArrayBuffer(32);
  new Uint8Array(buffer).fill(0xab);
  return buffer;
}

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(size > 0 ? size : 0)], name, { type });
  // jsdom honors size from the blob bits, but for the too-large branch we
  // need a synthetic size without allocating gigabytes; redefine in place.
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

function getHiddenInput(): HTMLInputElement {
  const input = document.querySelector("input[type=file]") as HTMLInputElement | null;
  if (!input) throw new Error("hidden file input not found");
  return input;
}

describe("SourceArtifactDropZone", () => {
  it("renders the default empty-state copy and hidden file input", () => {
    render(<SourceArtifactDropZone onArtifact={() => {}} />);
    expect(screen.getByText("Drop a file here")).toBeInTheDocument();
    expect(screen.getByText("Or click to choose a file from your computer.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /drop a file here or click to choose/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeInTheDocument();
    const input = getHiddenInput();
    expect(input).toBeInTheDocument();
  });

  it("normalizes accepted extensions for the hidden file input", () => {
    render(
      <SourceArtifactDropZone
        onArtifact={() => {}}
        acceptedContentTypes={[" text/csv "]}
        acceptedFileExtensions={["csv", ".tsv", " "]}
      />,
    );

    expect(getHiddenInput()).toHaveAttribute("accept", "text/csv,.csv,.tsv");
  });

  it("renders the footerNote slot when provided and hides it when omitted", () => {
    // Without the prop, the footer note slot is absent — the absence
    // reads truthfully as "no supplemental copy" rather than an empty
    // wrapper. With the prop, the slot renders the host-supplied node.
    const { rerender } = render(<SourceArtifactDropZone onArtifact={() => {}} />);
    expect(screen.queryByTestId("source-artifact-drop-zone-footer-note")).toBeNull();

    rerender(
      <SourceArtifactDropZone
        onArtifact={() => {}}
        footerNote={<span>CSV import agent · won't write anything until you save</span>}
      />,
    );
    expect(screen.getByTestId("source-artifact-drop-zone-footer-note")).toHaveTextContent(
      "CSV import agent · won't write anything until you save",
    );
  });

  it("invokes the hidden file input when the drop zone is clicked", () => {
    render(<SourceArtifactDropZone onArtifact={() => {}} />);
    const input = getHiddenInput();
    const clickSpy = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: /drop a file here or click to choose/i }));
    expect(clickSpy).toHaveBeenCalled();
  });

  it("emits a SourceArtifact-shaped value when a CSV file is picked", async () => {
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockResolvedValue(makeStubbedDigest());
    const onArtifact = vi.fn<(selection: SourceArtifactSelection) => void>();
    const onError = vi.fn<(error: SourceArtifactError) => void>();
    render(<SourceArtifactDropZone onArtifact={onArtifact} onError={onError} />);

    const input = getHiddenInput();
    const file = makeFile("upload.csv", "text/csv", 1024);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onArtifact).toHaveBeenCalledTimes(1));
    expect(digestSpy).toHaveBeenCalledWith("SHA-256", expect.any(ArrayBuffer));
    expect(onError).not.toHaveBeenCalled();

    const selection = onArtifact.mock.calls[0]?.[0];
    const artifact = selection?.artifact;
    expect(artifact).toMatchObject({
      name: "upload.csv",
      contentType: "text/csv",
      sizeBytes: 1024,
    });
    expect(artifact?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact?.sha256).toBe(`sha256:${"ab".repeat(32)}`);
    expect(typeof artifact?.id).toBe("string");
    expect(artifact?.id.length).toBeGreaterThan(0);
    expect(typeof artifact?.uploadedAtMs).toBe("number");
    expect(selection?.file).toBe(file);
    expect(selection?.bytes).toBeInstanceOf(ArrayBuffer);
    expect(selection?.bytes.byteLength).toBe(1024);
  });

  it("accepts extension-matched files when the browser reports an empty MIME type", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(makeStubbedDigest());
    const onArtifact = vi.fn<(selection: SourceArtifactSelection) => void>();
    const onError = vi.fn<(error: SourceArtifactError) => void>();
    render(
      <SourceArtifactDropZone
        onArtifact={onArtifact}
        onError={onError}
        acceptedContentTypes={["text/csv"]}
        acceptedFileExtensions={[".csv"]}
      />,
    );

    const input = getHiddenInput();
    const file = makeFile("upload.csv", "", 12);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onArtifact).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
    expect(onArtifact.mock.calls[0]?.[0].artifact.contentType).toBe("");
  });

  it("reports too_large errors without emitting an artifact", async () => {
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockResolvedValue(makeStubbedDigest());
    const onArtifact = vi.fn<(selection: SourceArtifactSelection) => void>();
    const onError = vi.fn<(error: SourceArtifactError) => void>();
    render(<SourceArtifactDropZone onArtifact={onArtifact} onError={onError} maxBytes={100} />);

    const input = getHiddenInput();
    const file = makeFile("oversized.csv", "text/csv", 500);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toEqual({
      kind: "too_large",
      sizeBytes: 500,
      maxBytes: 100,
    });
    expect(onArtifact).not.toHaveBeenCalled();
    expect(digestSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/too large/i);
  });

  it("reports unsupported_content_type without emitting an artifact", async () => {
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockResolvedValue(makeStubbedDigest());
    const onArtifact = vi.fn<(selection: SourceArtifactSelection) => void>();
    const onError = vi.fn<(error: SourceArtifactError) => void>();
    render(
      <SourceArtifactDropZone
        onArtifact={onArtifact}
        onError={onError}
        acceptedContentTypes={["text/csv"]}
      />,
    );

    const input = getHiddenInput();
    const file = makeFile("notes.pdf", "application/pdf", 256);
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0]?.[0]).toEqual({
      kind: "unsupported_content_type",
      contentType: "application/pdf",
    });
    expect(onArtifact).not.toHaveBeenCalled();
    expect(digestSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/unsupported/i);
  });
});
