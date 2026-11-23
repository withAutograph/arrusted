import { useEffect, useMemo, useRef, useState } from "react";

import type { ChatMessageView } from "@modules/agent-chat";

import type { WorkspaceDraft } from "./draft";
import { workspaceConversation, workspaceRequestFits } from "./limits";
import { CsvAgentWorkspace } from "./CsvAgentWorkspace";
import { CsvImportHistory, SavedImportDiff } from "./CsvImportHistory";
import { CsvWorkspaceRequestError, type CsvWorkspaceClient } from "./client";
import { buildCsvWorkspacePresentation, type CsvWorkspaceRecordLabel } from "./presentation";
import {
  clearPendingSave,
  createPendingSaveAttempt,
  pendingSaveDraft,
  pendingSaveStorageKey,
  readPendingSave,
  saveOutcomeIsDefinitiveRejection,
  writePendingSave,
  type CsvWorkspaceRecoveryStorage,
  type PendingSaveAttempt,
} from "./save-recovery";
import type {
  CsvWorkspaceContext,
  CsvWorkspaceRecoveryContext,
  CsvWorkspaceSaveResult,
} from "./types";

const DEFAULT_INITIAL_INSTRUCTION =
  "Interpret every source row and populated column across the supplied domain models. Prepare one atomic draft, including related records and relationships. Optional schema fields still carry source meaning; do not omit them merely because they are optional. Explain identity matches, assumptions, and any source meaning you could not confidently represent.";

function sameRecoveryContext(
  left: CsvWorkspaceRecoveryContext,
  right: CsvWorkspaceRecoveryContext,
) {
  return (
    left.appId === right.appId &&
    left.customerId === right.customerId &&
    left.actorId === right.actorId &&
    left.asOf === right.asOf
  );
}

export type InstalledCsvWorkspaceProps = {
  client: CsvWorkspaceClient;
  context: CsvWorkspaceContext;
  initialInstruction?: string;
  recordLabel?: CsvWorkspaceRecordLabel;
  recoveryStorage?: CsvWorkspaceRecoveryStorage;
  recoveryStorageNamespace?: string;
  onContextChange?: (context: CsvWorkspaceContext) => void;
  onRunStart?: () => void;
  onRunReset?: () => void;
};

export function InstalledCsvWorkspace(props: InstalledCsvWorkspaceProps) {
  const installationKey = `${pendingSaveStorageKey(
    props.context.recoveryContext,
    props.recoveryStorageNamespace,
  )}:${props.context.asOf}`;
  return <InstalledCsvWorkspaceInstance key={installationKey} {...props} />;
}

function InstalledCsvWorkspaceInstance(props: InstalledCsvWorkspaceProps) {
  const storageRef = useRef<CsvWorkspaceRecoveryStorage | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const storageKey = pendingSaveStorageKey(
    props.context.recoveryContext,
    props.recoveryStorageNamespace,
  );
  const [context, setContext] = useState(props.context);
  const [draft, setDraft] = useState<WorkspaceDraft | null>(null);
  const [source, setSource] = useState({ name: "", csv: "" });
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<CsvWorkspaceSaveResult | null>(null);
  const [pendingSave, setPendingSave] = useState<PendingSaveAttempt | null>(null);
  const activeTurn = useRef<AbortController | null>(null);
  const pendingSaveRef = useRef(pendingSave);
  const { recoveryStorage, onRunStart } = props;
  const recoveryContext = props.context.recoveryContext;
  useEffect(() => {
    if (storageRef.current) return;
    try {
      const storage = recoveryStorage ?? window.localStorage;
      const pending = readPendingSave(storage, storageKey, recoveryContext);
      storageRef.current = storage;
      pendingSaveRef.current = pending;
      setPendingSave(pending);
      if (pending) onRunStart?.();
      // This reflects completion of a browser-only read, not a changed prop.
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setRecoveryReady(true);
    } catch {
      // Fail closed after a browser-storage read error; this is not derived prop state.
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setError(
        "Save recovery storage could not be read. Restore browser storage access and reload before importing.",
      );
    }
  }, [recoveryStorage, storageKey, recoveryContext, onRunStart]);
  const presentation = useMemo(
    () => buildCsvWorkspacePresentation(context, draft, props.recordLabel),
    [context, draft, props.recordLabel],
  );
  useEffect(
    () => () => {
      activeTurn.current?.abort();
      activeTurn.current = null;
    },
    [],
  );

  async function turn(
    instruction: string,
    currentDraft: WorkspaceDraft,
    csv = source.csv,
    filename = source.name,
  ) {
    if (pendingSaveRef.current) return;
    activeTurn.current?.abort();
    const controller = new AbortController();
    activeTurn.current = controller;
    setRunning(true);
    setError(null);
    setDraft(currentDraft);
    const userMessage: ChatMessageView = {
      id: crypto.randomUUID(),
      role: "human",
      parts: [{ kind: "text", text: instruction }],
    };
    const conversation = workspaceConversation(
      messages.map((message) => ({
        role: message.role === "human" ? ("user" as const) : ("assistant" as const),
        content: message.parts
          .flatMap((part) => (part.kind === "text" ? [part.text] : []))
          .join("\n"),
      })),
    );
    setMessages((previous) => [...previous, userMessage]);
    try {
      const result = await props.client.turn(
        {
          csv,
          instruction,
          draft: currentDraft,
          conversation,
          schemaRevisionId: context.schemaRevisionId,
        },
        controller.signal,
      );
      if (activeTurn.current !== controller) return;
      const explanation = result.explanation;
      if (explanation)
        setMessages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            role: "agent",
            parts: [{ kind: "text", text: explanation }],
          },
        ]);
      if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join("\n"));
      const continuation = {
        schemaRevisionId: context.schemaRevisionId,
        csv,
        draft: result.draft,
        // A subsequent turn can reuse this instruction; larger new text is preflighted separately.
        instruction,
        conversation: workspaceConversation([
          ...conversation,
          { role: "user", content: instruction },
          ...(explanation ? [{ role: "assistant" as const, content: explanation }] : []),
        ]),
      };
      const saveRequest = {
        draft: result.draft,
        schemaRevisionId: context.schemaRevisionId,
        sourceFilename: filename,
        recoveryContext: context.recoveryContext,
        // Save generates a UUID. Measuring one does not create or persist an attempt.
        idempotencyKey: "00000000-0000-0000-0000-000000000000",
      };
      if (!workspaceRequestFits(saveRequest) || !workspaceRequestFits(continuation)) {
        throw new Error(
          "The prepared draft exceeds the 3 MiB Save or refinement request limit. Your previous draft is unchanged. Ask for a smaller draft or start with a smaller source file.",
        );
      }
      setDraft(result.draft);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Agent request failed");
      }
    } finally {
      if (activeTurn.current === controller) {
        activeTurn.current = null;
        setRunning(false);
      }
    }
  }

  function retainPendingSave(attempt: PendingSaveAttempt | null) {
    const storage = storageRef.current;
    if (!storage) throw new Error("Save recovery storage is unavailable");
    if (attempt) writePendingSave(storage, storageKey, attempt);
    else if (pendingSaveRef.current) {
      clearPendingSave(storage, storageKey, pendingSaveRef.current);
      attempt = readPendingSave(storage, storageKey, recoveryContext);
    }
    pendingSaveRef.current = attempt;
    setPendingSave(attempt);
  }

  async function save(currentDraft: WorkspaceDraft, recovery = false) {
    const payload = JSON.stringify(currentDraft);
    const existing = pendingSaveRef.current;
    if (existing && existing.payload !== payload) {
      setError("Resolve the pending Save before changing or importing another draft.");
      return;
    }
    if (!existing && (!source.name.trim() || source.name.length > 255)) {
      setError(
        "Save requires a source filename of at most 255 characters. Rename the file and start over.",
      );
      return;
    }
    const attempt =
      existing ??
      createPendingSaveAttempt(
        currentDraft,
        context.recoveryContext,
        context.schemaRevisionId,
        source.name,
      );
    try {
      retainPendingSave(attempt);
    } catch {
      setError("Save could not start because its recovery receipt could not be stored.");
      return;
    }
    setSaving(true);
    setError(null);
    if (!recovery) setDraft(currentDraft);
    try {
      const saved = await props.client.save({
        draft: currentDraft,
        idempotencyKey: attempt.key,
        recoveryContext: attempt.recoveryContext,
        sourceFilename: attempt.sourceFilename,
        schemaRevisionId: attempt.schemaRevisionId,
      });
      if (!sameRecoveryContext(saved.recoveryContext, attempt.recoveryContext)) {
        throw new Error("Save returned a receipt for a different workspace context");
      }
      const nextContext =
        attempt.recoveryContext.asOf === context.asOf
          ? { ...context, recordsByModel: saved.recordsByModel, activity: saved.activity }
          : await props.client.loadWorkspace();
      if (!sameRecoveryContext(nextContext.recoveryContext, context.recoveryContext)) {
        throw new Error("Workspace reload returned a different authenticated context");
      }
      retainPendingSave(null);
      setContext(nextContext);
      props.onContextChange?.(nextContext);
      setDraft(currentDraft);
      setReceipt(saved);
    } catch (failure) {
      if (
        failure instanceof CsvWorkspaceRequestError &&
        saveOutcomeIsDefinitiveRejection(failure.outcome)
      ) {
        retainPendingSave(null);
        if (draft === null && !pendingSaveRef.current) props.onRunReset?.();
      }
      setError(failure instanceof Error ? failure.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!recoveryReady) {
    return error ? <p role="alert">{error}</p> : <p role="status">Checking pending Save…</p>;
  }

  if (pendingSave && !receipt) {
    return (
      <SaveRecoveryPanel
        attempt={pendingSave}
        saving={saving}
        error={error}
        onRetry={() => {
          try {
            void save(pendingSaveDraft(pendingSave), true);
          } catch {
            setError("The pending Save receipt is invalid and cannot be retried.");
          }
        }}
      />
    );
  }

  return (
    <>
      <ImportRunActions
        canReset={Boolean(draft && !running && !saving && !receipt)}
        onReset={() => {
          setDraft(null);
          setSource({ name: "", csv: "" });
          setMessages([]);
          setError(null);
          props.onRunReset?.();
        }}
      />
      <CsvAgentWorkspace
        artifactName={source.name}
        draft={draft}
        presentation={presentation}
        messages={messages}
        running={running}
        saving={saving}
        error={error}
        onArtifact={(selection) => {
          props.onRunStart?.();
          const csv = new TextDecoder().decode(selection.bytes);
          setSource({ name: selection.file.name, csv });
          setMessages([]);
          setReceipt(null);
          void turn(
            props.initialInstruction ?? DEFAULT_INITIAL_INSTRUCTION,
            { revision: 0, rows: [] },
            csv,
            selection.file.name,
          );
        }}
        onFeedback={turn}
        onSave={save}
        onCancel={() => {
          activeTurn.current?.abort();
          activeTurn.current = null;
          setRunning(false);
        }}
        receipt={
          receipt ? (
            <SavedReceipt
              receipt={receipt}
              context={context}
              onReset={() => {
                setReceipt(null);
                setDraft(null);
                setMessages([]);
                if (!pendingSaveRef.current) props.onRunReset?.();
              }}
            />
          ) : undefined
        }
      />
      <CsvImportHistory client={props.client} context={context} />
    </>
  );
}

function ImportRunActions({ canReset, onReset }: { canReset: boolean; onReset: () => void }) {
  return canReset ? (
    <button type="button" onClick={onReset}>
      Start over
    </button>
  ) : null;
}

function SaveRecoveryPanel({
  attempt,
  saving,
  error,
  onRetry,
}: {
  attempt: PendingSaveAttempt;
  saving: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <section aria-label="Save recovery">
      <h2>Confirm the pending Save</h2>
      <p>
        The last Save did not return a confirmed result. Editing and new imports remain paused until
        the same reviewed request is retried.
      </p>
      <p>
        {attempt.sourceFilename} · Effective date {attempt.recoveryContext.asOf}
      </p>
      <button type="button" disabled={saving} onClick={onRetry}>
        {saving ? "Retrying Save..." : "Retry exact Save"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function SavedReceipt({
  receipt,
  context,
  onReset,
}: {
  receipt: CsvWorkspaceSaveResult;
  context: CsvWorkspaceContext;
  onReset: () => void;
}) {
  return (
    <div>
      <h2>Import saved</h2>
      <p>{receipt.diff.records.length} records saved. Review the changes below.</p>
      <SavedImportDiff diff={receipt.diff} context={context} />
      <button type="button" onClick={onReset}>
        Import another file
      </button>
    </div>
  );
}
