// Source-artifact drop zone composite.
//
// Generic file intake surface for the source-import module. Takes one file
// (drag-and-drop or picker), computes its SHA-256, and emits both metadata
// and the raw file/bytes to the host. The host owns storage and parsing; this
// composite is pure presentation + bytes-to-metadata conversion.
//
// No app semantics. The CTA / headline / subline copy is
// overridable so the consumer can phrase the intake the way the surface
// reads ("Drop a CSV here" for a CSV importer, etc.). Defaults are
// content-type-agnostic.

import { Button } from "@autograph/components";
import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from "react";

import type { SourceArtifact } from "../types";

import "./SourceArtifactDropZone.css";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const EMPTY_ACCEPTED_CONTENT_TYPES: readonly string[] = [];
const EMPTY_ACCEPTED_FILE_EXTENSIONS: readonly string[] = [];

export type SourceArtifactError =
  | { kind: "too_large"; sizeBytes: number; maxBytes: number }
  | { kind: "unsupported_content_type"; contentType: string }
  | { kind: "read_failed"; reason: string };

export type SourceArtifactSelection = {
  artifact: SourceArtifact;
  file: File;
  bytes: ArrayBuffer;
};

export type SourceArtifactDropZoneProps = {
  // Called when a file is accepted + hashed. The module emits the raw file
  // and bytes so the host can persist the source artifact before parsing.
  onArtifact: (selection: SourceArtifactSelection) => void;
  // Called for visible error states. The composite surfaces inline errors;
  // this hook lets the host log or surface a toast.
  onError?: (error: SourceArtifactError) => void;
  // Max file size in bytes; defaults to 50 MB. Configurable so the consumer
  // can lower it if needed.
  maxBytes?: number;
  // Restrict accepted content types. Empty means no MIME-type restriction.
  acceptedContentTypes?: readonly string[];
  // Restrict accepted filename extensions. Useful for browsers that report an
  // empty file.type for otherwise valid uploads.
  acceptedFileExtensions?: readonly string[];
  // Optional CTA label override; defaults to "Choose file".
  ctaLabel?: string;
  // Optional headline + subline override for the visual.
  headline?: string;
  subline?: string;
  // Optional supplemental copy rendered beneath the CTA, inside the drop
  // zone surface. The host owns the content (e.g. "CSV import agent ·
  // won't write anything until you save"). Omit to leave the footer
  // empty.
  footerNote?: ReactNode;
  // Optional className for layout adjustments by the host.
  className?: string;
};

type DropZoneState = "idle" | "drag-over" | "loading" | "error";

export function SourceArtifactDropZone(props: SourceArtifactDropZoneProps) {
  const {
    onArtifact,
    onError,
    maxBytes = DEFAULT_MAX_BYTES,
    acceptedContentTypes = EMPTY_ACCEPTED_CONTENT_TYPES,
    acceptedFileExtensions = EMPTY_ACCEPTED_FILE_EXTENSIONS,
    ctaLabel = "Choose file",
    headline = "Drop a file here",
    subline = "Or click to choose a file from your computer.",
    footerNote,
    className,
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<DropZoneState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Cheap counter to avoid flicker when dragging over nested elements: a
  // single dragenter -> dragleave pair on the outer drop target fires multiple
  // events when the cursor crosses descendant boundaries.
  const dragDepth = useRef(0);
  // Synchronous in-flight flag. The React `state === "loading"` guard
  // lags one render behind the drop event, so a rapid double-drop can
  // dispatch two concurrent `processFile` calls before the loading
  // state has propagated. The ref is set before any await and cleared
  // in finally so the next drop wins or loses atomically.
  const inFlightRef = useRef(false);

  const reportError = useCallback(
    (error: SourceArtifactError, displayMessage: string) => {
      setState("error");
      setErrorMessage(displayMessage);
      onError?.(error);
    },
    [onError],
  );

  const processFile = useCallback(
    async (file: File) => {
      // Validation order matters: type/name -> size -> read/hash. Each
      // branch returns early; onArtifact never fires after onError.
      if (!isAcceptedFile(file, acceptedContentTypes, acceptedFileExtensions)) {
        reportError(
          { kind: "unsupported_content_type", contentType: file.type },
          `Unsupported file type${file.type ? ` (${file.type})` : ""}.`,
        );
        return;
      }
      if (file.size > maxBytes) {
        reportError(
          { kind: "too_large", sizeBytes: file.size, maxBytes },
          `File is too large (${formatBytes(file.size)}; max ${formatBytes(maxBytes)}).`,
        );
        return;
      }

      // Synchronous claim BEFORE any await so a concurrent caller
      // (rapid double-drop, picker change racing a drop, etc.) bounces
      // off rather than dispatching a second `processFile` call.
      inFlightRef.current = true;
      setState("loading");
      setErrorMessage(null);

      try {
        let buffer: ArrayBuffer;
        try {
          buffer = await file.arrayBuffer();
        } catch (cause) {
          reportError(
            { kind: "read_failed", reason: errorReason(cause) },
            "Failed to read the file. Try again.",
          );
          return;
        }

        let digestBuffer: ArrayBuffer;
        try {
          digestBuffer = await crypto.subtle.digest("SHA-256", buffer);
        } catch (cause) {
          reportError(
            { kind: "read_failed", reason: errorReason(cause) },
            "Failed to hash the file. Try again.",
          );
          return;
        }

        const sha256 = `sha256:${bufferToHex(digestBuffer)}`;
        const artifact: SourceArtifact = {
          id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : fallbackId(),
          name: file.name,
          contentType: file.type,
          sha256,
          sizeBytes: file.size,
          uploadedAtMs: Date.now(),
        };
        setState("idle");
        onArtifact({ artifact, file, bytes: buffer });
      } finally {
        inFlightRef.current = false;
      }
    },
    [acceptedContentTypes, acceptedFileExtensions, maxBytes, onArtifact, reportError],
  );

  const handleClick = useCallback(() => {
    if (state === "loading") return;
    inputRef.current?.click();
  }, [state]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // The outer target uses role=button so it needs explicit keyboard
      // activation. The inner Button child remains a native button.
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset so the same file can be re-selected after an error.
      event.target.value = "";
      if (!file) return;
      void processFile(file);
    },
    [processFile],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (state === "loading") return;
      dragDepth.current += 1;
      setState((current) => (current === "loading" ? current : "drag-over"));
    },
    [state],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Required: without preventDefault on dragover the drop event never fires.
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) {
      setState((current) => (current === "drag-over" ? "idle" : current));
    }
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      // Synchronous in-flight check: a rapid double-drop fires the
      // second event before React state has propagated `loading`, so
      // the `state === "loading"` guard alone leaks a concurrent
      // `processFile` call. The ref check is the actual gate.
      if (inFlightRef.current) return;
      if (state === "loading") return;
      setState("idle");
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      void processFile(file);
    },
    [processFile, state],
  );

  const acceptAttribute = [
    ...acceptedContentTypes.flatMap((contentType) => {
      const trimmed = contentType.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }),
    ...acceptedFileExtensions.flatMap((extension) => {
      const normalized = normalizeExtension(extension);
      return normalized ? [normalized] : [];
    }),
  ].join(",");

  return (
    <section
      className={joinClassNames("source-artifact-drop-zone-wrapper", className)}
      aria-label="Source artifact drop zone"
    >
      <div
        role="button"
        tabIndex={0}
        className="source-artifact-drop-zone"
        data-state={state}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-busy={state === "loading"}
        // Distinct accessible name keeps the surface action addressable by
        // tests/screen readers without ambiguity vs. the inner CTA button
        // (which surfaces the explicit "Choose file" affordance).
        aria-label="Drop a file here or click to choose"
        aria-describedby={errorMessage ? "source-artifact-drop-zone-error" : undefined}
      >
        <span className="source-artifact-drop-zone__icon" aria-hidden="true">
          <ArrowDownIcon />
        </span>
        <h2 className="source-artifact-drop-zone__headline">{headline}</h2>
        <p className="source-artifact-drop-zone__subline">{subline}</p>
        <Button
          intent="primary"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            handleClick();
          }}
          disabled={state === "loading"}
        >
          {ctaLabel}
        </Button>
        {footerNote ? (
          <div
            className="source-artifact-drop-zone__footer-note"
            data-testid="source-artifact-drop-zone-footer-note"
          >
            {footerNote}
          </div>
        ) : null}
        {state === "loading" ? (
          <p className="source-artifact-drop-zone__loading" role="status">
            Reading file...
          </p>
        ) : null}
        {errorMessage ? (
          <p
            id="source-artifact-drop-zone-error"
            className="source-artifact-drop-zone__error"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
      </div>
      <input
        ref={inputRef}
        className="source-artifact-drop-zone__hidden-input"
        type="file"
        accept={acceptAttribute}
        onChange={handleInputChange}
        tabIndex={-1}
        aria-hidden="true"
      />
    </section>
  );
}

function ArrowDownIcon() {
  // Inline SVG: the icons barrel does not currently expose a download / arrow
  // arrow-down semantic icon. Inlining one symbol locally is cheaper than
  // widening the icon barrel for a single in-module use; if a second surface
  // wants the same glyph, promote to `@autograph/icons`.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const out: string[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[i] = bytes[i]!.toString(16).padStart(2, "0");
  }
  return out.join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function errorReason(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown_error";
}

function isAcceptedFile(
  file: File,
  acceptedContentTypes: readonly string[],
  acceptedFileExtensions: readonly string[],
): boolean {
  if (acceptedContentTypes.length === 0 && acceptedFileExtensions.length === 0) return true;
  if (file.type && acceptedContentTypes.includes(file.type)) return true;
  const lowerName = file.name.toLowerCase();
  return acceptedFileExtensions.some((extension) =>
    lowerName.endsWith(normalizeExtension(extension)),
  );
}

function normalizeExtension(extension: string): string {
  const lower = extension.trim().toLowerCase();
  if (lower.length === 0) return "";
  return lower.startsWith(".") ? lower : `.${lower}`;
}

function fallbackId(): string {
  // Test environments without crypto.randomUUID still get a unique-enough id.
  // Production browsers have randomUUID; this is the cliff-edge fallback.
  return `artifact_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function joinClassNames(...values: (string | undefined | null | false)[]): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
