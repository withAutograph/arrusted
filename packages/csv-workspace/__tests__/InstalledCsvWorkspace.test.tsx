import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { ChatMessageView } from "@modules/agent-chat";

import { CsvWorkspaceRequestError, type CsvWorkspaceClient } from "../client";
import type { WorkspaceDraft } from "../draft";
import type { CsvWorkspaceContext, CsvWorkspaceSaveResult } from "../types";

let sourceFilename = "laboratory.csv";
let sourceCsv = "accession,title";
let feedbackDraft: WorkspaceDraft | undefined;

vi.mock("../CsvAgentWorkspace", () => ({
  CsvAgentWorkspace: (props: {
    draft: WorkspaceDraft | null;
    onArtifact: (selection: { file: File; bytes: Uint8Array }) => void;
    onSave: (draft: WorkspaceDraft) => void;
    onFeedback: (message: string, draft: WorkspaceDraft) => void;
    messages: readonly ChatMessageView[];
    error?: string | null;
    receipt?: ReactNode;
  }) => (
    <div>
      {!props.draft ? (
        <button
          type="button"
          onClick={() =>
            props.onArtifact({
              file: new File(["accession,title"], sourceFilename, { type: "text/csv" }),
              bytes: new TextEncoder().encode(sourceCsv),
            })
          }
        >
          Upload fixture
        </button>
      ) : (
        <button type="button" onClick={() => props.onSave(props.draft!)}>
          Save draft
        </button>
      )}
      {props.receipt ? <div>Receipt visible{props.receipt}</div> : null}
      <button onClick={() => props.onFeedback("Correct the draft", feedbackDraft ?? props.draft!)}>
        Refine
      </button>
      <output data-testid="current-draft">{JSON.stringify(props.draft)}</output>
      {props.messages.map((message) => (
        <p key={message.id} data-role={message.role}>
          {message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n")}
        </p>
      ))}
      {props.error ? <p role="alert">{props.error}</p> : null}
    </div>
  ),
}));

import { InstalledCsvWorkspace } from "../InstalledCsvWorkspace";
import {
  createPendingSaveAttempt,
  pendingSaveStorageKey,
  writePendingSave,
} from "../save-recovery";

const recoveryContext = {
  appId: "laboratory_intake",
  customerId: "north_lab",
  actorId: "lab-reviewer",
  asOf: "2027-03-15",
};
const context = {
  schemaRevisionId: "71",
  schema: { models: [], change_types: [] },
  scope: { appId: "laboratory_intake", customerId: "north_lab" },
  actorId: "lab-reviewer",
  asOf: "2027-03-15",
  recoveryContext,
  policies: [],
  recordsByModel: {},
  activity: [],
} as unknown as CsvWorkspaceContext;
const draft: WorkspaceDraft = {
  revision: 1,
  rows: [
    {
      rowId: "specimen-row",
      modelId: "specimen",
      recordId: "specimen-1",
      operation: "create",
      effectiveStart: "2027-03-15",
      values: { title: { type: "text", value: "Human reviewed" } },
      clearFields: [],
    },
  ],
};

describe("installed CSV workspace", () => {
  beforeEach(() => {
    localStorage.clear();
    sourceCsv = "accession,title";
    sourceFilename = "laboratory.csv";
    feedbackDraft = undefined;
  });

  it("renders without reading browser storage and checks recovery after mount", () => {
    const storage = {
      length: 1,
      key: vi.fn(() => `${pendingSaveStorageKey(recoveryContext)}:missing`),
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const client = {} as CsvWorkspaceClient;
    const html = renderToString(
      <InstalledCsvWorkspace context={context} client={client} recoveryStorage={storage} />,
    );
    expect(html).toContain("Checking pending Save");
    expect(storage.getItem).not.toHaveBeenCalled();
    render(<InstalledCsvWorkspace context={context} client={client} recoveryStorage={storage} />);
    expect(storage.getItem).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Upload fixture" })).toBeInTheDocument();
  });

  it("blocks a new import when recovery storage cannot be read", () => {
    const storage = {
      length: 1,
      key: () => `${pendingSaveStorageKey(recoveryContext)}:missing`,
      getItem: () => {
        throw new Error("Denied");
      },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    render(
      <InstalledCsvWorkspace
        context={context}
        client={{} as CsvWorkspaceClient}
        recoveryStorage={storage}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Save recovery storage could not be read");
    expect(screen.queryByRole("button", { name: "Upload fixture" })).not.toBeInTheDocument();
  });

  it("allows selecting another file after initial agent failure", async () => {
    const onRunReset = vi.fn();
    const client = {
      turn: vi.fn().mockRejectedValue(new Error("Provider unavailable")),
    } as unknown as CsvWorkspaceClient;
    render(<InstalledCsvWorkspace context={context} client={client} onRunReset={onRunReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByRole("button", { name: "Upload fixture" })).toBeInTheDocument();
    expect(onRunReset).toHaveBeenCalledOnce();
  });

  it("rejects an oversized filename before retaining a Save attempt", async () => {
    sourceFilename = "x".repeat(256);
    const save = vi.fn();
    const client = {
      turn: vi.fn().mockResolvedValue({ ok: true, draft, metadata: {} }),
      save,
    } as unknown as CsvWorkspaceClient;
    render(<InstalledCsvWorkspace context={context} client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
    await screen.findByRole("button", { name: "Start over" });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("at most 255 characters");
    expect(save).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(screen.queryByRole("region", { name: "Save recovery" })).not.toBeInTheDocument();
  });

  it.each([
    { boundary: "continuation", sourceBytes: 1600 * 1024, draftCharacters: 800 * 1024 },
    { boundary: "Save", sourceBytes: 20, draftCharacters: 1600 * 1024 },
  ])(
    "rejects a result exceeding $boundary and retains the captured prior draft",
    async ({ sourceBytes, draftCharacters }) => {
      sourceCsv = "title\n" + "x".repeat(sourceBytes);
      const expanded = structuredClone(draft);
      expanded.revision = 2;
      expanded.rows[0]!.values.title = { type: "text", value: "é".repeat(draftCharacters) };
      const client = {
        getJson: vi.fn(),
        postJson: vi.fn(),
        loadWorkspace: vi.fn(),
        save: vi.fn(),
        turn: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, draft, explanation: "Prepared", metadata: {} })
          .mockResolvedValueOnce({
            ok: true,
            draft: expanded,
            explanation: "Expanded",
            metadata: {},
          }),
      } as unknown as CsvWorkspaceClient;
      render(<InstalledCsvWorkspace client={client} context={context} />);
      fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
      await waitFor(() =>
        expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(draft)),
      );
      feedbackDraft = structuredClone(draft);
      feedbackDraft.rows[0]!.values.title = { type: "text", value: "Human correction" };
      fireEvent.click(screen.getByRole("button", { name: "Refine" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("previous draft is unchanged");
      expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(feedbackDraft));
      expect(client.save).not.toHaveBeenCalled();
      expect(localStorage.length).toBe(0);
    },
  );

  it("recovers yesterday's uncertain Save before another import and sends the original request", async () => {
    const attempt = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "yesterday.csv",
      "original-save-request-key",
    );
    writePendingSave(localStorage, pendingSaveStorageKey(recoveryContext), attempt);
    const nextDay = {
      ...context,
      schemaRevisionId: "72",
      asOf: "2027-03-16",
      recoveryContext: { ...recoveryContext, asOf: "2027-03-16" },
    };
    const client = {
      getJson: vi.fn(),
      postJson: vi.fn(),
      turn: vi.fn(),
      loadWorkspace: vi.fn().mockResolvedValue(nextDay),
      save: vi.fn().mockResolvedValue({
        applied: { id: 17 },
        recordsByModel: {},
        activity: [],
        diff: { records: [] },
        recoveryContext,
      }),
    } as unknown as CsvWorkspaceClient;
    render(<InstalledCsvWorkspace client={client} context={nextDay} />);

    expect(screen.queryByRole("button", { name: "Upload fixture" })).not.toBeInTheDocument();
    expect(screen.getByText("yesterday.csv · Effective date 2027-03-15")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Save" }));
    await waitFor(() =>
      expect(client.save).toHaveBeenCalledWith({
        draft,
        idempotencyKey: attempt.key,
        recoveryContext,
        schemaRevisionId: "71",
        sourceFilename: "yesterday.csv",
      }),
    );
    expect(await screen.findByText("Receipt visible")).toBeInTheDocument();
    expect(client.loadWorkspace).toHaveBeenCalledOnce();
    expect(client.turn).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("unlocks the run after the last restored Save is definitively rejected", async () => {
    const first = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "first.csv",
      "first-save-request-key",
    );
    const second = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "second.csv",
      "second-save-request-key",
    );
    const key = pendingSaveStorageKey(recoveryContext);
    writePendingSave(localStorage, key, first);
    writePendingSave(localStorage, key, second);
    const onRunStart = vi.fn();
    const onRunReset = vi.fn();
    const client = {
      save: vi.fn().mockRejectedValue(new CsvWorkspaceRequestError("Rejected", 422, "not_applied")),
    } as unknown as CsvWorkspaceClient;
    render(
      <InstalledCsvWorkspace
        client={client}
        context={context}
        onRunStart={onRunStart}
        onRunReset={onRunReset}
      />,
    );
    expect(onRunStart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Save" }));
    await screen.findByText("second.csv · Effective date 2027-03-15");
    expect(onRunReset).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry exact Save" }));
    await screen.findByRole("button", { name: "Upload fixture" });
    expect(onRunReset).toHaveBeenCalledOnce();
    expect(localStorage.length).toBe(0);
    expect(client.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: second.key }),
    );
  });

  it("retains a current draft and its run date after a definitive Save rejection", async () => {
    const onRunReset = vi.fn();
    const client = {
      turn: vi.fn().mockResolvedValue({ ok: true, draft, metadata: {} }),
      save: vi.fn().mockRejectedValue(new CsvWorkspaceRequestError("Rejected", 422, "not_applied")),
    } as unknown as CsvWorkspaceClient;
    render(<InstalledCsvWorkspace client={client} context={context} onRunReset={onRunReset} />);
    fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
    await waitFor(() =>
      expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(draft)),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByRole("button", { name: "Start over" });
    expect(onRunReset).not.toHaveBeenCalled();
    expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(draft));
    expect(localStorage.length).toBe(0);
  });

  it("owns the turn and sends one exact context-bound Save", async () => {
    const turn = vi.fn().mockResolvedValue({
      ok: true,
      draft,
      explanation: "Prepared one specimen.",
      issues: [],
      metadata: {},
    });
    const saved = {
      applied: { id: 17 },
      recordsByModel: {},
      activity: [],
      diff: { records: [] },
      recoveryContext,
    } as unknown as CsvWorkspaceSaveResult;
    const save = vi.fn().mockResolvedValue(saved);
    const onRunReset = vi.fn();
    const client = {
      getJson: vi.fn(),
      postJson: vi.fn(),
      loadWorkspace: vi.fn(),
      turn,
      save,
    } as unknown as CsvWorkspaceClient;
    render(<InstalledCsvWorkspace client={client} context={context} onRunReset={onRunReset} />);

    fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
    await waitFor(() => expect(turn).toHaveBeenCalledOnce());
    expect(turn.mock.calls[0]?.[0]).toMatchObject({
      csv: "accession,title",
      schemaRevisionId: context.schemaRevisionId,
      draft: { revision: 0, rows: [] },
      conversation: [],
    });

    fireEvent.click(await screen.findByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      draft,
      recoveryContext,
      sourceFilename: "laboratory.csv",
    });
    expect(save.mock.calls[0]?.[0].idempotencyKey).toMatch(/^[a-zA-Z0-9-]{16,128}$/u);
    expect(await screen.findByText("Receipt visible")).toBeInTheDocument();
    expect(onRunReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Import another file" }));
    expect(onRunReset).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Upload fixture" })).toBeInTheDocument();
  });

  it("retains the agent's rejected-proposal explanation and the current draft", async () => {
    const turn = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        draft,
        explanation: "Prepared one specimen.",
        metadata: {},
      })
      .mockResolvedValueOnce({
        ok: false,
        explanation: "I could not change the specimen because its accession is required.",
        issues: [{ code: "required_field", message: "Accession is required" }],
      })
      .mockRejectedValueOnce(new Error("Provider unavailable"));
    const client = { turn } as unknown as CsvWorkspaceClient;
    const view = render(<InstalledCsvWorkspace client={client} context={context} />);
    fireEvent.click(screen.getByRole("button", { name: "Upload fixture" }));
    await screen.findByText("Prepared one specimen.");
    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Accession is required");
    expect(
      screen.getByText("I could not change the specimen because its accession is required."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(draft));

    fireEvent.click(screen.getByRole("button", { name: "Refine" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable"),
    );
    expect(view.container.querySelectorAll('[data-role="agent"]')).toHaveLength(2);
    expect(screen.getByTestId("current-draft").textContent).toBe(JSON.stringify(draft));
  });
});
