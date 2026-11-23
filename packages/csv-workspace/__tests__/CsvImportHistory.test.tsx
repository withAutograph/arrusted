import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CsvWorkspaceContext } from "../types";
import type { CsvWorkspaceClient } from "../client";
import { CsvImportHistory } from "../CsvImportHistory";

describe("saved import history", () => {
  it("shows saved file attribution and loads canonical before/after effects after reopening", async () => {
    const context = {
      schema: {
        custom_fields: [
          { id: "definition-1", field_id: "cf-1", model_id: "other", label: "Wrong model" },
          { id: "definition-1", field_id: "cf-1", model_id: "sample", label: "Lab note" },
        ],
        models: [
          {
            id: "sample",
            label: "Sample",
            display_field_id: "caption",
            fields: [{ id: "caption", label: "Caption" }],
          },
        ],
      },
      recordsByModel: {
        sample: [
          { record_id: "sample-1", values: { caption: { type: "text", value: "Corrected" } } },
        ],
      },
      activity: [
        {
          change_set_id: 8,
          source_kind: "human",
          source_ref: "csv:lab.csv",
          actor_id: "reviewer",
          applied_at: "2026-09-07T10:00:00Z",
          touched_record_count: 1,
        },
        {
          change_set_id: 9,
          source_kind: "integration",
          source_ref: "csv:unrelated.csv",
          touched_record_count: 1,
        },
      ],
    } as unknown as CsvWorkspaceContext;
    const getJson = vi.fn().mockResolvedValue({
      records: [
        {
          model_id: "sample",
          record_id: "sample-1",
          version_id: "v1",
          effective_start: "2026-09-07",
          fields: [
            {
              field_id: "caption",
              before: { type: "text", value: "Original" },
              after: { type: "text", value: "Corrected" },
            },
          ],
          custom_fields: [
            { field_id: "cf-1", before: null, after: { type: "text", value: "Reviewed" } },
          ],
        },
      ],
    });
    render(
      <CsvImportHistory context={context} client={{ getJson } as unknown as CsvWorkspaceClient} />,
    );
    expect(screen.getByText(/reviewer/)).toBeInTheDocument();
    expect(screen.queryByText("unrelated.csv")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "lab.csv" }));
    expect(await screen.findByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    expect(screen.getByText("Lab note")).toBeInTheDocument();
    expect(screen.queryByText("Wrong model")).not.toBeInTheDocument();
    expect(getJson).toHaveBeenCalledWith("/api/diff?change_set_id=8");
  });
});
