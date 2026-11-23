import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ComponentProps, ReactNode } from "react";
import type { Schema, ModelId } from "@contracts";
import type { EditableGridPreviewController } from "@modules/editable-grid";
import { InstalledCsvWorkspace, createAuthenticatedCsvWorkspaceClient } from "../index";
import {
  createCsvWorkspaceService,
  createCsvWorkspaceRequestHandler,
  type CanonicalKernelOperations,
} from "../server";

const grid = vi.hoisted(() => ({ controller: null as EditableGridPreviewController | null }));
// Keep the real editable-grid controller and PreviewSavePanel; jsdom replaces only its visual canvas.
vi.mock("@modules/editable-grid", async (original) => ({
  ...(await original<typeof import("@modules/editable-grid")>()),
  EditableRowVersionGrid: () => <div aria-label="Editable data review" />,
}));
vi.mock("@modules/source-import", async (original) => {
  const actual = await original<typeof import("@modules/source-import")>();
  return {
    ...actual,
    PreviewSavePanel: (props: ComponentProps<typeof actual.PreviewSavePanel>) => (
      <actual.PreviewSavePanel
        {...props}
        onControllersChange={(controllers: ReadonlyMap<ModelId, EditableGridPreviewController>) => {
          grid.controller = controllers.values().next().value ?? null;
          props.onControllersChange?.(controllers);
        }}
      />
    ),
  };
});
vi.mock("@modules/agent-chat", () => ({
  MessageThread: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PromptInput: () => null,
}));
afterEach(() => {
  grid.controller = null;
  localStorage.clear();
});
const scope = { appId: "people", customerId: "customer", actorId: "reviewer", asOf: "2026-09-07" };
const text = (value: string) => ({ type: "text" as const, value });

async function mount(fail = false) {
  const kernel: CanonicalKernelOperations = {
    readVisibleRecords: vi.fn(async () => []),
    validateChangeSetDryRun: vi.fn(async () => ({ alreadyApplied: false })),
    applyChangeSet: vi.fn(async () => ({ id: 1, schema_revision_id: "1" })),
    recentActivity: vi.fn(async () => []),
    changeSetDiff: vi.fn(async () => ({ change_set_id: 1, source_change_set_id: 1, records: [] })),
  };
  const service = createCsvWorkspaceService({
    context: scope,
    schemaRevisionId: "1",
    kernel,
    schema: {
      models: [
        {
          id: "person",
          label: "Person",
          kind: "entity",
          fields: [
            { id: "name", label: "Name", type: "text" },
            { id: "note", label: "Note", type: "text" },
          ],
        },
      ],
      change_types: [],
    } as unknown as Schema,
    policies: [{ modelId: "person", rungs: [{ kind: "name", fieldId: "name" }] }],
    domainInstructions: "Import people",
    agent: { model: { provider: "test", model: "test" } },
    runner: async ({ tools }) => {
      if (fail) throw new Error("Provider unavailable");
      const call = (id: string, args: unknown) =>
        tools!.find((tool) => tool.definition.id === id)!.execute(args);
      await call("resolve_identity", {
        modelId: "person",
        valuesJson: JSON.stringify({ name: text("Alice"), note: text("Keep") }),
        effectiveStart: scope.asOf,
      });
      expect(
        await call("compute_draft", {
          code: "input => ({ additions: input.identityGrants, amendments: [] })",
        }),
      ).toMatchObject({ accepted: true });
      return {
        text: "Prepared",
        metadata: {
          runId: "run",
          identityId: "test",
          executionProfileId: "test",
          provider: "test",
          model: "test",
          toolSurface: [],
        },
        toolCalls: [],
        toolResults: [],
        steps: [],
      };
    },
  });
  const handler = createCsvWorkspaceRequestHandler(service);
  const client = createAuthenticatedCsvWorkspaceClient({
    asOf: scope.asOf,
    baseUrl: "https://test.invalid/api",
    fetch: (input, init) => handler(new Request(String(input), init)),
  });
  const context = await client.loadWorkspace();
  const view = render(<InstalledCsvWorkspace client={client} context={context} />);
  const file = new File(["name,note\nAlice,Keep"], "people.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("name,note\nAlice,Keep").buffer,
  });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [file] },
  });
  return { kernel, view };
}

it("validates a real grid partial revert through HTTP Save, then allows an intentional identity correction", async () => {
  const { kernel } = await mount();
  await waitFor(() => expect(grid.controller?.pendingChangesByRow.size).toBe(1));
  const key = grid.controller!.pendingChangesByRow.keys().next().value!;
  act(() => grid.controller!.revertField(key, "name"));
  await waitFor(() =>
    expect(
      grid.controller!.pendingChangesByRow.get(key)!.fieldChanges.map((change) => change.fieldId),
    ).toEqual(["note"]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("identity");
  expect(kernel.applyChangeSet).not.toHaveBeenCalled();
  expect(localStorage.length).toBe(0);
  act(() => {
    expect(
      grid.controller!.stageBulkUpdate({
        rows: [{ rowKey: key }],
        fieldId: "name",
        value: text("Alicia"),
        bulkGroupId: "human",
        effectiveStart: scope.asOf,
      }),
    ).toMatchObject({ ok: true });
  });
  await waitFor(() =>
    expect(grid.controller!.pendingChangesByRow.get(key)!.fieldChanges).toHaveLength(2),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
  expect(await screen.findByRole("heading", { name: "Import saved" })).toBeInTheDocument();
  expect(kernel.applyChangeSet).toHaveBeenCalledOnce();
  expect(vi.mocked(kernel.applyChangeSet).mock.calls[0]![0].writes[0]!.effective_start).toBe(
    scope.asOf,
  );
  expect(vi.mocked(kernel.applyChangeSet).mock.calls[0]![0].writes[0]!.values).toEqual({
    name: text("Alicia"),
    note: text("Keep"),
  });
});

it("restores the actual drop zone after a failed first upload", async () => {
  const { view } = await mount(true);
  expect(await screen.findByRole("alert")).toHaveTextContent("Provider unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  expect(view.container.querySelector('input[type="file"]')).toBeInTheDocument();
  expect(screen.getByText("Drop a CSV here")).toBeInTheDocument();
});
