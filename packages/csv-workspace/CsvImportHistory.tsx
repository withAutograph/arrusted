import { useState } from "react";
import type { ChangeSetDiff, FieldValue } from "../contracts/index";
import type { CsvWorkspaceClient } from "./client";
import type { CsvWorkspaceContext } from "./types";

function displayValue(value: FieldValue | null | undefined): string {
  if (!value || !("value" in value) || value.value === null) return "—";
  if (typeof value.value === "boolean") return value.value ? "Yes" : "No";
  return typeof value.value === "object" ? JSON.stringify(value.value) : String(value.value);
}

export function SavedImportDiff(props: { diff: ChangeSetDiff; context: CsvWorkspaceContext }) {
  return (
    <div className="csv-import-history__changes">
      {props.diff.records.map((record) => {
        const model = props.context.schema.models.find(
          (candidate) => candidate.id === record.model_id,
        );
        const current = props.context.recordsByModel[record.model_id]?.find(
          (candidate) => candidate.record_id === record.record_id,
        );
        const label = model?.display_field_id
          ? displayValue(current?.values[model.display_field_id])
          : record.record_id;
        return (
          <section key={record.version_id}>
            <h4>
              {model?.label ?? record.model_id} · {label}
            </h4>
            <p>Effective {record.effective_start}</p>
            <table>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...record.fields.map((field) => ({
                    ...field,
                    label: model?.fields.find((candidate) => candidate.id === field.field_id)
                      ?.label,
                  })),
                  ...record.custom_fields.map((field) => ({
                    ...field,
                    label: props.context.schema.custom_fields?.find(
                      (candidate) =>
                        candidate.model_id === record.model_id &&
                        candidate.field_id === field.field_id,
                    )?.label,
                  })),
                ].map((field) => (
                  <tr key={field.field_id}>
                    <th scope="row">{field.label ?? field.field_id}</th>
                    <td>{displayValue(field.before as FieldValue | null)}</td>
                    <td>{displayValue(field.after as FieldValue | null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

/** Saved effects come from ordinary change sets; no import session or value store. */
export function CsvImportHistory(props: {
  client: CsvWorkspaceClient;
  context: CsvWorkspaceContext;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [diff, setDiff] = useState<ChangeSetDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const imports = props.context.activity.filter(
    (entry) => entry.source_kind === "human" && entry.source_ref?.startsWith("csv:"),
  );
  if (!imports.length) return null;
  return (
    <section className="csv-import-history" aria-label="Saved imports">
      <h3>Recent saved imports</h3>
      <ul>
        {imports.map((entry) => (
          <li key={entry.change_set_id}>
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                setSelected(entry.change_set_id);
                setDiff(null);
                setError(null);
                setLoading(true);
                try {
                  setDiff(
                    await props.client.getJson<ChangeSetDiff>(
                      `/api/diff?change_set_id=${entry.change_set_id}`,
                    ),
                  );
                } catch {
                  setError("The saved changes could not be loaded. Select the import to retry.");
                } finally {
                  setLoading(false);
                }
              }}
            >
              {entry.source_ref!.slice(4)}
            </button>
            <span>
              {entry.actor_id ?? "Unknown actor"} ·{" "}
              <time dateTime={entry.applied_at ?? entry.created_at}>
                {new Date(entry.applied_at ?? entry.created_at).toLocaleString("en-CA", {
                  timeZone: "UTC",
                  timeZoneName: "short",
                })}
              </time>{" "}
              · {entry.touched_record_count} records
            </span>
          </li>
        ))}
      </ul>
      {selected !== null ? (
        <div aria-live="polite">
          {loading ? <p>Loading saved changes…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {diff ? <SavedImportDiff diff={diff} context={props.context} /> : null}
        </div>
      ) : null}
    </section>
  );
}
