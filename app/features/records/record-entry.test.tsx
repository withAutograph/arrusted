import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RecordEntry } from "./record-entry";
import { definition } from "../../../packages/work-session-tools/__tests__/fixture";
const mocks = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./actions", () => ({ previewRecords: mocks.preview, saveRecords: mocks.save }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function open() {
  render(<RecordEntry models={definition.models} initialDate="2026-11-19" />);
  fireEvent.click(screen.getByText("Add records or import CSV"));
  mocks.preview.mockImplementation(async (input) => ({ input, schemaRevisionId: "12" }));
}
test("human previews create values and retries the exact save payload after an uncertain result", async () => {
  open();
  fireEvent.change(screen.getByLabelText("Owner (required for new records)"), {
    target: { value: "Jane" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByRole("heading", { name: /Review 1 row/ });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Effective date").closest("fieldset")?.disabled).toBe(true);
  mocks.save.mockRejectedValueOnce(new Error("Connection lost; retry Save"));
  mocks.save.mockResolvedValueOnce({ count: 1, changeSetId: 42 });
  fireEvent.click(screen.getByRole("button", { name: "Apply records" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Apply records" }));
  await screen.findByText("1 row saved. Change 42.");
  expect(mocks.save.mock.calls[0]).toEqual(mocks.save.mock.calls[1]);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
test("CSV column mapping previews only mapped fields and external keys before apply", async () => {
  open();
  fireEvent.change(screen.getByLabelText("Entry method"), { target: { value: "csv" } });
  const file = new File(["person,external_key\nJane,person-1"], "people.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: async () => "person,external_key\nJane,person-1" });
  fireEvent.change(screen.getByLabelText("CSV file"), { target: { files: [file] } });
  fireEvent.change(await screen.findByLabelText("person"), { target: { value: "owner" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByRole("heading", { name: /Review 1 row/ });
  expect(mocks.preview.mock.calls[0]?.[0].rows).toEqual([
    { values: { owner: "Jane" }, externalKey: "person-1" },
  ]);
  expect(mocks.save).not.toHaveBeenCalled();
});
test("Claude proposal is explicit human preview and can be saved as a native draft", async () => {
  open();
  fireEvent.change(screen.getByLabelText("Entry method"), { target: { value: "proposal" } });
  const proposal = {
    model: "item",
    asOf: "2026-10-01",
    requestId: "01234567-0123-4012-8012-012345678901",
    rows: [{ values: { owner: "Claude proposal" } }],
  };
  fireEvent.change(screen.getByLabelText("Proposal JSON from Claude"), {
    target: { value: JSON.stringify(proposal) },
  });
  fireEvent.change(screen.getByLabelText("Save as"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  await screen.findByRole("heading", { name: /2026-10-01/ });
  mocks.save.mockResolvedValueOnce({ count: 1, changeSetId: 43 });
  fireEvent.click(screen.getByRole("button", { name: "Save drafts" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith(proposal, "draft", "12"));
});

test("validation errors are displayed without enabling Save", async () => {
  open();
  mocks.preview.mockResolvedValueOnce({ error: "Title is required" });
  fireEvent.click(screen.getByRole("button", { name: "Preview changes" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Title is required");
  expect(screen.queryByRole("button", { name: "Apply records" })).toBeNull();
});
