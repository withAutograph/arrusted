"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { DataModel } from "@autograph/generated-app-runtime/data";
import type { RecordImport } from "@autograph/work-session-tools/records";
import {
  externalKeyColumn,
  mapImportCsv,
  maxImportBytes,
  readImportCsv,
} from "@autograph/csv-workspace/mapping";
import { previewRecords, saveRecords } from "./actions";

function previewValue(value: unknown) {
  if (value === undefined) return "Unchanged";
  if (value === null) return "Clear";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function RecordEntry({
  models,
  initialDate,
}: {
  models: readonly DataModel[];
  initialDate: string;
}) {
  const router = useRouter();
  const [modelId, setModelId] = useState(models[0]?.id ?? "");
  const model = models.find((candidate) => candidate.id === modelId);
  const fields =
    model?.fields.filter(
      (field) =>
        !field.aliasOf &&
        !field.readOnly &&
        field.lifecycle !== "retired" &&
        field.storage !== "custom",
    ) ?? [];
  const [asOf, setAsOf] = useState(initialDate);
  const [entry, setEntry] = useState<"record" | "csv" | "proposal">("record");
  const [proposal, setProposal] = useState("");
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [externalKey, setExternalKey] = useState("");
  const [mode, setMode] = useState<"mainline" | "draft">("mainline");
  const [review, setReview] = useState<{
    input: RecordImport;
    revision: string;
    mode: "mainline" | "draft";
  } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const reviewFields = fields.filter((field) =>
    review?.input.rows.some((row) => Object.hasOwn(row.values, field.id)),
  );
  if (!model) return null;
  function resetReview() {
    setReview(null);
    setMessage("");
    setError("");
  }
  function fail(error: unknown) {
    setError(
      error instanceof Error
        ? error.message
        : "Could not complete the request. Retry the same Save if its result is uncertain.",
    );
  }
  async function loadCsv(file: File | undefined) {
    resetReview();
    if (!file) return;
    try {
      if (file.size > maxImportBytes) throw new Error("Choose a CSV file no larger than 512 KiB.");
      const source = await file.text();
      const parsed = readImportCsv(source);
      setCsv(source);
      setHeaders(parsed.headers);
      setMapping(
        Object.fromEntries(
          parsed.headers.map((header) => {
            const normalize = (text: string) => text.toLowerCase().replace(/[ _-]/g, "");
            const field = fields.find((field) =>
              [field.id, field.name, String(field.label ?? "")].some(
                (name) => normalize(name) === normalize(header),
              ),
            );
            return [
              header,
              normalize(header) === "externalkey" ? externalKeyColumn : (field?.id ?? ""),
            ];
          }),
        ),
      );
    } catch (error) {
      setCsv("");
      setHeaders([]);
      fail(error);
    }
  }
  function preview() {
    resetReview();
    startTransition(async () => {
      try {
        const rows =
          entry === "csv"
            ? mapImportCsv(csv, mapping)
            : [
                {
                  values: Object.fromEntries(
                    Object.entries(values).filter(([, value]) => value !== ""),
                  ),
                  ...(externalKey ? { externalKey } : {}),
                },
              ];
        const input: RecordImport =
          entry === "proposal"
            ? JSON.parse(proposal)
            : { model: modelId, asOf, requestId: crypto.randomUUID(), rows };
        if (!models.some((model) => model.id === input.model))
          throw new Error("This proposal belongs to another table. Open that table to review it.");
        const result = await previewRecords(input, mode);
        if ("error" in result) {
          setError(result.error);
          return;
        }
        setModelId(input.model);
        setReview({ input: result.input, revision: result.schemaRevisionId, mode });
      } catch (error) {
        fail(error);
      }
    });
  }
  function save() {
    if (!review) return;
    setError("");
    startTransition(async () => {
      try {
        const result = await saveRecords(review.input, review.mode, review.revision);
        if ("error" in result) {
          setError(result.error);
          return;
        }
        setMessage(
          `${result.count} row${result.count === 1 ? "" : "s"} ${review.mode === "draft" ? "saved as drafts for review" : "saved"}. Change ${result.changeSetId}.`,
        );
        setReview(null);
        setValues({});
        setExternalKey("");
        setCsv("");
        setHeaders([]);
        router.refresh();
      } catch (error) {
        fail(error);
      }
    });
  }
  return (
    <details className="record-entry">
      <summary>Add records or import CSV</summary>
      <fieldset disabled={pending || review !== null}>
        <legend>Record entry</legend>
        {models.length > 1 ? (
          <label>
            Table
            <select
              value={modelId}
              onChange={(event) => {
                setModelId(event.target.value);
                setValues({});
                setCsv("");
                setHeaders([]);
                resetReview();
              }}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {String(model.label ?? model.name)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Effective date
          <input
            type="date"
            value={asOf}
            onChange={(event) => {
              setAsOf(event.target.value);
              resetReview();
            }}
          />
        </label>
        <label>
          Entry method
          <select
            value={entry}
            onChange={(event) => {
              setEntry(event.target.value as "record" | "csv" | "proposal");
              resetReview();
            }}
          >
            <option value="record">New record</option>
            <option value="csv">Import CSV</option>
            <option value="proposal">Claude proposal</option>
          </select>
        </label>
        {entry === "record" ? (
          <>
            <label>
              External key (optional)
              <input value={externalKey} onChange={(event) => setExternalKey(event.target.value)} />
            </label>
            {fields.map((field) => (
              <label key={field.id}>
                {String(field.label ?? field.name)}
                {field.required ? " (required for new records)" : ""}
                {field.type === "enum" || field.type === "bool" ? (
                  <select
                    value={values[field.id] ?? ""}
                    onChange={(event) =>
                      setValues((values) => ({ ...values, [field.id]: event.target.value }))
                    }
                  >
                    <option value="">Leave empty</option>
                    {(field.type === "bool"
                      ? [
                          { id: "true", label: "True" },
                          { id: "false", label: "False" },
                        ]
                      : (field.option_set ?? [])
                    ).map((option) => (
                      <option key={option.id} value={option.id}>
                        {String(option.label ?? option.id)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === "date" ? "date" : "text"}
                    value={values[field.id] ?? ""}
                    onChange={(event) =>
                      setValues((values) => ({ ...values, [field.id]: event.target.value }))
                    }
                    placeholder={
                      [
                        "json",
                        "money_rate",
                        "relation_list",
                        "known_aliases",
                        "text_list",
                      ].includes(field.type)
                        ? "JSON value"
                        : field.type === "relation"
                          ? "Related record ID"
                          : undefined
                    }
                  />
                )}
              </label>
            ))}
          </>
        ) : entry === "proposal" ? (
          <label>
            Proposal JSON from Claude
            <textarea
              rows={8}
              value={proposal}
              onChange={(event) => setProposal(event.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => void loadCsv(event.target.files?.[0])}
              />
            </label>
            <p>
              Up to 100 rows. Map an external key to update matching records on repeat imports.
              Duplicate keys within a file are refused. Empty cells leave existing values unchanged.
            </p>
            {headers.map((header) => (
              <label key={header}>
                {header}
                <select
                  value={mapping[header] ?? ""}
                  onChange={(event) =>
                    setMapping((mapping) => ({ ...mapping, [header]: event.target.value }))
                  }
                >
                  <option value="">Skip column</option>
                  <option value={externalKeyColumn}>External key</option>
                  {fields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {String(field.label ?? field.name)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </>
        )}
        <label>
          Save as
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as "mainline" | "draft")}
          >
            <option value="mainline">Apply directly</option>
            <option value="draft">Drafts for review</option>
          </select>
        </label>
        <button type="button" onClick={preview} disabled={entry === "csv" && !csv}>
          Preview changes
        </button>
      </fieldset>
      {review ? (
        <section aria-label="Import preview">
          <h3>
            Review {review.input.rows.length} row{review.input.rows.length === 1 ? "" : "s"} ·{" "}
            {review.input.asOf}
          </h3>
          <p>
            {review.mode === "draft"
              ? "Save these rows as drafts for review in Canvas."
              : "Apply these rows directly."}{" "}
            Rows with external keys update matching records; other rows create records.
          </p>
          <div className="record-preview">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>External key</th>
                  {reviewFields.map((field) => (
                    <th key={field.id}>{String(field.label ?? field.name)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {review.input.rows.map((row, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    <td>{row.externalKey ?? "New record"}</td>
                    {reviewFields.map((field) => (
                      <td key={field.id}>{previewValue(row.values[field.id])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="button" className="primary" disabled={pending} onClick={save}>
            {pending ? "Saving…" : review.mode === "draft" ? "Save drafts" : "Apply records"}
          </button>{" "}
          <button type="button" disabled={pending} onClick={() => setReview(null)}>
            Back to editing
          </button>
        </section>
      ) : null}
      {pending && !review ? <p role="status">Checking records…</p> : null}
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </details>
  );
}
