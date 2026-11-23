import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { WorkspaceDraft } from "../draft";
import {
  clearPendingSave,
  createPendingSaveAttempt,
  pendingSaveDraft,
  pendingSaveStorageKey,
  readPendingSave,
  saveOutcomeIsDefinitiveRejection,
  writePendingSave,
} from "../save-recovery";
import type { CsvWorkspaceRecoveryContext } from "../types";

const recoveryContext = {
  appId: "laboratory_intake",
  customerId: "north_lab",
  actorId: "lab-reviewer",
  asOf: "2027-03-15",
} as CsvWorkspaceRecoveryContext;
const storageKey = pendingSaveStorageKey(recoveryContext);

const draft: WorkspaceDraft = {
  revision: 4,
  rows: [
    {
      rowId: "row-1",
      modelId: "employee",
      recordId: "employee-1",
      operation: "update",
      effectiveStart: "2026-09-06",
      values: { name: { type: "text", value: "Human correction" } },
      clearFields: ["notes"],
    },
  ],
};

describe("pending Save recovery", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips the exact reviewed payload and idempotency key", () => {
    const attempt = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "customer-import.csv",
      "same-save-request-key",
    );
    writePendingSave(localStorage, storageKey, attempt);

    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(attempt);
    expect(readPendingSave(localStorage, storageKey, recoveryContext)?.sourceFilename).toBe(
      "customer-import.csv",
    );
    expect(pendingSaveDraft(readPendingSave(localStorage, storageKey, recoveryContext)!)).toEqual(
      draft,
    );
    expect(readPendingSave(localStorage, storageKey, recoveryContext)?.payload).toBe(
      JSON.stringify(draft),
    );
  });

  it("removes corrupt state instead of authorizing an unrelated retry", () => {
    localStorage.setItem(`${storageKey}:short`, JSON.stringify({ key: "short", payload: "{}" }));

    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it("never replays an exact payload across actor or workspace context", () => {
    const attempt = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "customer-import.csv",
      "context-bound-save-key",
    );
    writePendingSave(localStorage, storageKey, attempt);

    expect(
      readPendingSave(localStorage, storageKey, {
        ...recoveryContext,
        actorId: "another-reviewer",
      }),
    ).toBeNull();
  });

  it("finds an uncertain Save after the default date changes and retains its original revision and date", () => {
    const attempt = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "past.csv",
      "same-save-request-key",
    );
    writePendingSave(localStorage, storageKey, attempt);
    const tomorrow = { ...recoveryContext, asOf: "2027-03-16" };

    expect(pendingSaveStorageKey(tomorrow)).toBe(storageKey);
    expect(readPendingSave(localStorage, pendingSaveStorageKey(tomorrow), tomorrow)).toEqual(
      attempt,
    );
    expect(readPendingSave(localStorage, storageKey, tomorrow)?.schemaRevisionId).toBe("71");
  });

  it("clears the receipt only after the caller confirms the result", () => {
    writePendingSave(
      localStorage,
      storageKey,
      createPendingSaveAttempt(
        draft,
        recoveryContext,
        "71",
        "customer-import.csv",
        "confirmed-save-key",
      ),
    );
    clearPendingSave(
      localStorage,
      storageKey,
      readPendingSave(localStorage, storageKey, recoveryContext)!,
    );

    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toBeNull();
  });

  it("preserves independently written tab receipts when either request resolves", () => {
    const first = createPendingSaveAttempt(
      draft,
      recoveryContext,
      "71",
      "first.csv",
      "first-save-request-key",
    );
    const second = createPendingSaveAttempt(
      { ...draft, revision: 5 },
      recoveryContext,
      "71",
      "second.csv",
      "second-save-request-key",
    );
    writePendingSave(localStorage, storageKey, first);
    writePendingSave(localStorage, storageKey, second);
    // A retry from the first tab cannot overwrite the second tab's receipt.
    writePendingSave(localStorage, storageKey, first);
    expect(localStorage.length).toBe(2);
    clearPendingSave(localStorage, storageKey, first);
    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(second);
    // A late confirmation from the first tab cannot clear the second request.
    clearPendingSave(localStorage, storageKey, first);
    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(second);
    clearPendingSave(localStorage, storageKey, second);
    expect(readPendingSave(localStorage, storageKey, recoveryContext)).toBeNull();
  });

  it.each(["legacy", "current"])(
    "preserves old and new receipts when %s resolves first",
    (first) => {
      const legacy = createPendingSaveAttempt(
        draft,
        recoveryContext,
        "71",
        "old.csv",
        "legacy-save-request-key",
      );
      const current = createPendingSaveAttempt(
        { ...draft, revision: 5 },
        recoveryContext,
        "72",
        "new.csv",
        "current-save-request-key",
      );
      const original = JSON.stringify(legacy);
      localStorage.setItem(storageKey, original);
      writePendingSave(localStorage, storageKey, current);
      expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(legacy);
      expect(localStorage.getItem(storageKey)).toBe(original);
      // Retrying the exact old request may also retain its new per-request entry.
      writePendingSave(localStorage, storageKey, legacy);
      const resolved = first === "legacy" ? legacy : current;
      const remaining = first === "legacy" ? current : legacy;
      clearPendingSave(localStorage, storageKey, resolved);
      expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(remaining);
      clearPendingSave(localStorage, storageKey, resolved);
      expect(readPendingSave(localStorage, storageKey, recoveryContext)).toEqual(remaining);
      clearPendingSave(localStorage, storageKey, remaining);
      expect(localStorage.length).toBe(0);
    },
  );

  it("unfreezes only for a definitive canonical rejection", () => {
    expect(saveOutcomeIsDefinitiveRejection("not_applied")).toBe(true);
    expect(saveOutcomeIsDefinitiveRejection(422)).toBe(false);
    expect(saveOutcomeIsDefinitiveRejection("receipt_failed")).toBe(false);
    expect(saveOutcomeIsDefinitiveRejection(undefined)).toBe(false);
  });
});
