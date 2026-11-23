import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Page } from "playwright";
import type { WorkspaceDraft, WorkspaceRow } from "../index";

const ORIGIN = process.env.CSV_WORKSPACE_INSTALLED_ORIGIN ?? "http://127.0.0.1:4510";
const AUTH_ORIGIN = process.env.CSV_WORKSPACE_AUTH_ORIGIN ?? ORIGIN;
const OUTPUT = path.resolve(
  process.env.CSV_INSTALLED_OUTPUT ?? "output/playwright/csv-workspace-installed",
);
const TURN_TIMEOUT_MS = 5 * 60_000;
const MOUNT_TIMEOUT_MS = Number(process.env.CSV_INSTALLED_MOUNT_TIMEOUT_MS ?? "60000");
const AS_OF = "2026-09-06";
const APP_FILTER = process.env.CSV_INSTALLED_APP;
const SCALE_ROWS = Number(process.env.CSV_INSTALLED_SCALE_ROWS ?? "0");
const RECOVERY_PROOF = process.env.CSV_INSTALLED_RECOVERY === "1";
const SCALE_ONLY = process.env.CSV_INSTALLED_SCALE_ONLY === "1";
let turnArtifactIndex = 0;

if (new URL(ORIGIN).hostname !== "127.0.0.1") {
  throw new Error("Installed-app CSV proof is restricted to the loopback Gateway");
}
if (APP_FILTER && APP_FILTER !== "hc" && APP_FILTER !== "vendor") {
  throw new Error("CSV_INSTALLED_APP must be hc or vendor");
}

type AppCase = {
  name: "hc" | "vendor";
  route: string;
  endpoint: string;
  fixture: string;
  filename: string;
  modelLabel: RegExp;
  modelId: string;
  editField: string;
  editValue: string;
  targetValuePrefix?: string;
};

const CASES: readonly AppCase[] = [
  {
    name: "hc",
    route: "/hc/#/data-sources/import",
    endpoint: "/hc/api/csv-workspace",
    fixture: path.resolve("packages/csv-workspace/__tests__/fixtures/workforce.csv"),
    filename: "workforce.csv",
    modelLabel: /Employee/u,
    modelId: "employee",
    editField: "name",
    editValue: "Katherine G. Johnson",
    targetValuePrefix: "Katherine Johnson",
  },
  {
    name: "vendor",
    route: "/vendor/data-import",
    endpoint: "/vendor/api/csv-workspace",
    fixture: path.resolve("packages/csv-workspace/__tests__/fixtures/vendor-spend.csv"),
    filename: "vendor-spend.csv",
    modelLabel: /Vendor Spend Transaction/u,
    modelId: "vendor_spend_transaction",
    editField: "source_record_id",
    editValue: "bill-human-reviewed",
  },
];

function scalar(row: WorkspaceRow, fieldId: string) {
  const value = row.values[fieldId];
  return value && "value" in value && typeof value.value === "string" ? value.value : undefined;
}

function targetRow(draft: WorkspaceDraft, app: AppCase) {
  const rows = draft.rows.filter((row) => row.modelId === app.modelId);
  assert.ok(rows.length > 0, `${app.name} agent produced a ${app.modelId} row`);
  const targetValuePrefix = app.targetValuePrefix;
  if (!targetValuePrefix) return rows[0]!;
  const row = rows.find((candidate) =>
    scalar(candidate, app.editField)?.startsWith(targetValuePrefix),
  );
  assert.ok(row, `${app.name} agent produced the intended row for manual review`);
  return row;
}

function relationId(row: WorkspaceRow, fieldId: string) {
  const value = row.values[fieldId];
  return value?.type === "relation" &&
    typeof value.value === "object" &&
    value.value.type === "record_id"
    ? value.value.value
    : undefined;
}

function assertVendorSourceCoverage(draft: WorkspaceDraft) {
  const vendors = draft.rows.filter((row) => row.modelId === "vendor");
  assert.equal(vendors.length, 2, "Vendor agent prepared both distinct vendors");
  for (const vendor of vendors) {
    assert.ok(relationId(vendor, "department"), "Vendor retained its Department relation");
    assert.ok(relationId(vendor, "owner"), "Vendor retained its Owner relation");
  }
  const transactions = draft.rows.filter((row) => row.modelId === "vendor_spend_transaction");
  assert.equal(transactions.length, 3, "Vendor agent prepared every source transaction");
  const vendorRelations = transactions.map((row) => relationId(row, "vendor"));
  assert.ok(vendorRelations.every(Boolean), "Every transaction retained its Vendor relation");
  assert.deepEqual(
    [
      ...new Map(
        vendorRelations.map((id) => [id, vendorRelations.filter((value) => value === id).length]),
      ).values(),
    ].sort((left, right) => left - right),
    [1, 2],
    "Two transactions share the same new Vendor and one uses the other Vendor",
  );
}

function assertHcAssignmentCoverage(draft: WorkspaceDraft, filename: string) {
  const prefix = `EMP-${filename.slice(0, 13)}-`;
  const sourceRefs = new Set(["001", "002", "003"].map((suffix) => prefix + suffix));
  const allEmployees = draft.rows.filter((row) => row.modelId === "employee");
  assert.equal(allEmployees.length, 4, "HC prepares three source employees and one manager");
  assert.deepEqual(
    new Set(allEmployees.map((row) => scalar(row, "ref"))),
    new Set([...sourceRefs, `${prefix}GRACE`]),
    "HC retains exactly the supplied employee identities",
  );
  const employees = allEmployees.filter((row) => sourceRefs.has(scalar(row, "ref") ?? ""));
  assert.equal(employees.length, 3, "HC agent retained every source employee");
  assert.deepEqual(
    new Set(employees.map((row) => scalar(row, "ref"))),
    sourceRefs,
    "Every source employee ref is retained exactly once",
  );
  const employeeIds = new Set(employees.map((row) => row.recordId));
  const assignments = draft.rows.filter((row) => row.modelId === "org_assignment");
  assert.equal(assignments.length, 3, "HC agent prepared every dated manager assignment");
  assert.deepEqual(
    new Set(assignments.map((row) => relationId(row, "employee"))),
    employeeIds,
    "Every assignment targets one of the three source employees",
  );
  assert.ok(
    assignments.every((row) => scalar(row, "start_date") === AS_OF),
    "Every assignment retained the CSV Assignment Start date",
  );
  const manager = draft.rows.find(
    (row) => row.modelId === "employee" && scalar(row, "ref") === `${prefix}GRACE`,
  );
  assert.ok(manager, "HC agent prepared the manager from the supplied Manager Ref");
  const managerIds = assignments.map((row) => relationId(row, "reports_to_employee"));
  assert.ok(
    managerIds.every((id) => id === manager.recordId),
    "Assignments use the supplied manager identity",
  );
  assert.ok(managerIds.every(Boolean), "Every assignment retained its Grace Hopper manager");
  assert.equal(
    new Set(managerIds).size,
    1,
    "Every assignment references the same Grace Hopper employee",
  );
  assert.ok(
    !employeeIds.has(managerIds[0]!),
    "The Grace Hopper manager is distinct from the three source employees",
  );
}

async function signIn(page: Page) {
  await page.goto(AUTH_ORIGIN, { waitUntil: "domcontentloaded" });
  const status = await page.evaluate(async () => {
    const response = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callbackURL: "/",
        email: "admin@apps.localhost",
        password: "local-apps-admin",
      }),
    });
    return response.status;
  });
  assert.equal(status, 200, `local Better Auth sign-in succeeded (${status})`);
}

async function waitForTurn(page: Page, app: AppCase, action: () => Promise<void>) {
  const startedAt = performance.now();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `${app.endpoint}/turn`,
    { timeout: TURN_TIMEOUT_MS },
  );
  await action();
  const response = await responsePromise;
  const result = (await response.json()) as {
    ok?: boolean;
    issues?: Array<{ message?: string }>;
    draft?: WorkspaceDraft;
    metadata?: unknown;
  };
  turnArtifactIndex += 1;
  await writeFile(
    path.join(OUTPUT, `${app.name}-turn-${turnArtifactIndex}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  assert.equal(response.status(), 200, `${app.name} agent turn returned HTTP 200`);
  assert.equal(
    result.ok,
    true,
    result.issues?.map((issue) => issue.message).join("; ") ?? `${app.name} turn failed`,
  );
  assert.ok(result.draft, `${app.name} agent returned a draft`);
  console.log(
    JSON.stringify({
      event: "agent-turn",
      app: app.name,
      metadata: result.metadata,
      modelRowCounts: Object.fromEntries(
        [...new Set(result.draft.rows.map((row) => row.modelId))].map((modelId) => [
          modelId,
          result.draft!.rows.filter((row) => row.modelId === modelId).length,
        ]),
      ),
    }),
  );
  await page.getByText("Agent working…", { exact: true }).waitFor({
    state: "hidden",
    timeout: TURN_TIMEOUT_MS,
  });
  return {
    draft: result.draft,
    elapsedMs: Math.round(performance.now() - startedAt),
    metadata: result.metadata,
  };
}

async function editTextCell(page: Page, app: AppCase, draft: WorkspaceDraft) {
  await page.getByRole("tab", { name: app.modelLabel }).first().click();
  const grid = page.locator(
    '.preview-save-panel__mount[data-visible="true"] [data-grid="editable-row-version"]',
  );
  const reviewedRow = targetRow(draft, app);
  const reviewedGridRowId =
    reviewedRow.operation === "create" ? `tmp:${reviewedRow.rowId}` : reviewedRow.recordId;
  const renderedRow = grid.locator(
    `.ag-center-cols-container .ag-row[row-id="${reviewedGridRowId}"]`,
  );
  await renderedRow.waitFor();
  const gridRowId = await renderedRow.getAttribute("row-id");
  assert.ok(gridRowId, `${app.name} grid rendered a stable row ID`);
  const row = draft.rows.find((candidate) =>
    candidate.operation === "create"
      ? gridRowId === `tmp:${candidate.rowId}`
      : gridRowId === candidate.recordId,
  );
  assert.ok(row, `${app.name} grid row maps to the reviewed draft`);
  const cell = renderedRow.locator(`[role="gridcell"][col-id="${app.editField}"]`);
  await cell.scrollIntoViewIfNeeded();
  await cell.dblclick();
  const editor = cell.locator("input").first();
  await editor.waitFor();
  await editor.fill(app.editValue);
  await editor.press("Enter");
  return row;
}

async function runInstalledApp(page: Page, app: AppCase) {
  await page.goto(`${ORIGIN}${app.route}`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByLabel("CSV import").waitFor({ timeout: MOUNT_TIMEOUT_MS });
  } catch (error) {
    console.error(
      JSON.stringify({
        resources: await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((entry) => ({ name: entry.name, duration: entry.duration })),
        ),
        dateInputKeys: await page.evaluate(() =>
          Object.keys(document.querySelector('input[type="date"]') ?? {}).filter((key) =>
            key.startsWith("__react"),
          ),
        ),
      }),
    );
    throw new Error(
      `${app.name} workspace did not mount: ${(await page.locator("body").innerText()).slice(0, 2_000)}`,
      { cause: error },
    );
  }
  const date = page.getByLabel("Effective date");
  await date.fill(AS_OF);
  const fixture = await readFile(app.fixture, "utf8");
  const source =
    app.name === "hc"
      ? fixture
          .replaceAll("EMP-", `EMP-${app.filename.slice(0, 13)}-`)
          .replaceAll("@example.test", `+${app.filename.slice(0, 13)}@example.test`)
          .replaceAll("Ada Lovelace", `Ada Lovelace ${app.filename.slice(0, 13)}`)
          .replaceAll("Katherine Johnson", `Katherine Johnson ${app.filename.slice(0, 13)}`)
          .replaceAll("Dorothy Vaughan", `Dorothy Vaughan ${app.filename.slice(0, 13)}`)
      : fixture
          .replaceAll("ACME", `ACME ${app.filename.slice(0, 13)}`)
          .replaceAll("New Analytics", `New Analytics ${app.filename.slice(0, 13)}`)
          .replaceAll("fixture:bill:", `${app.filename.slice(0, 13)}:bill:`)
          .replaceAll("bill-", `${app.filename.slice(0, 13)}-bill-`)
          .replaceAll("INV-", `${app.filename.slice(0, 13)}-INV-`);

  const initialTurn = await waitForTurn(page, app, () =>
    page.locator('input[type="file"]').setInputFiles({
      name: app.filename,
      mimeType: "text/csv",
      buffer: Buffer.from(source),
    }),
  );
  assert.equal(await date.isDisabled(), true, `${app.name} date froze when the run started`);
  const row = await editTextCell(page, app, initialTurn.draft);

  await page
    .getByLabel("Message the agent")
    .fill(
      app.name === "vendor"
        ? "Attach each vendor to its Department and Owner from the source, creating any identity-safe related rows needed. Recheck the identity assumptions and explain them. Preserve every manual grid edit exactly."
        : "Include the dated manager assignments from the file as well. Preserve every manual grid edit exactly.",
    );
  const refinedTurn = await waitForTurn(page, app, () =>
    page.getByRole("button", { name: "Send" }).click(),
  );
  const refinedRow = refinedTurn.draft.rows.find((candidate) => candidate.rowId === row.rowId);
  assert.ok(refinedRow, `${app.name} feedback retained the manually edited row`);
  if (app.name === "vendor") assertVendorSourceCoverage(refinedTurn.draft);
  if (app.name === "hc") assertHcAssignmentCoverage(refinedTurn.draft, app.filename);
  assert.equal(
    scalar(refinedRow, app.editField),
    app.editValue,
    `${app.name} feedback preserved the unquoted human grid edit`,
  );

  let saveRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `${app.endpoint}/save`) {
      saveRequests += 1;
    }
  });
  let committedChangeSetId: number | undefined;
  if (RECOVERY_PROOF) {
    await page.route(
      `**${app.endpoint}/save?*`,
      async (route) => {
        const response = await route.fetch();
        const result = (await response.json()) as { applied?: { id?: number } };
        assert.equal(response.status(), 200, `${app.name} intercepted Save committed`);
        assert.equal(typeof result.applied?.id, "number", `${app.name} Save returned a change set`);
        committedChangeSetId = result.applied!.id;
        await route.fulfill({ status: 504, body: "" });
      },
      { times: 1 },
    );
    await page.getByRole("button", { name: /^Save \d+ changes$/u }).click();
    await page.getByRole("heading", { name: "Confirm the pending Save" }).waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Confirm the pending Save" }).waitFor();
    const retryResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `${app.endpoint}/save`,
    );
    await page.getByRole("button", { name: "Retry exact Save" }).click();
    const retryResponse = await retryResponsePromise;
    const retryResult = (await retryResponse.json()) as { applied?: { id?: number } };
    assert.equal(
      retryResult.applied?.id,
      committedChangeSetId,
      `${app.name} exact retry returned the committed change set`,
    );
  } else {
    await page.getByRole("button", { name: /^Save \d+ changes$/u }).click();
  }
  await page.getByRole("heading", { name: "Import saved" }).waitFor({ timeout: 60_000 });
  assert.equal(saveRequests, RECOVERY_PROOF ? 2 : 1, `${app.name} used the expected Save requests`);
  await page.screenshot({ path: path.join(OUTPUT, `${app.name}-saved.png`), fullPage: true });

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Saved imports").waitFor({ timeout: 60_000 });
  const historyItem = page.getByRole("button", { name: app.filename });
  await historyItem.waitFor();
  assert.equal(await historyItem.count(), 1, `${app.name} exact retry created one change set`);
  const historyText = await historyItem.locator("xpath=..").innerText();
  assert.doesNotMatch(historyText, /Unknown actor/u, `${app.name} history retained actor identity`);
  await historyItem.click();
  await page.getByText("Loading saved changes…").waitFor({ state: "hidden" });
  await page.getByText(app.editValue, { exact: true }).waitFor();
  if (app.name === "vendor") {
    assert.equal(
      await page
        .locator("tr")
        .filter({ has: page.getByRole("rowheader", { name: "Department" }) })
        .count(),
      2,
      "Vendor reload retained both Department relations",
    );
    assert.equal(
      await page
        .locator("tr")
        .filter({ has: page.getByRole("rowheader", { name: "Spend Owned By" }) })
        .count(),
      2,
      "Vendor reload retained both Owner relations",
    );
    assert.equal(
      await page
        .locator("tr")
        .filter({ has: page.getByRole("rowheader", { name: "Vendor" }) })
        .count(),
      5,
      "Vendor reload retained both vendor names and every transaction Vendor relation",
    );
  }

  return {
    app: app.name,
    date: AS_OF,
    filename: app.filename,
    manualEdit: app.editValue,
    initialAgentElapsedMs: initialTurn.elapsedMs,
    initialAgentMetadata: initialTurn.metadata,
    initialDraftRows: initialTurn.draft.rows.length,
    refinementAgentElapsedMs: refinedTurn.elapsedMs,
    refinementAgentMetadata: refinedTurn.metadata,
    saveRequests,
    committedChangeSetId,
  };
}

function vendorScaleCsv(rowCount: number) {
  const runId = `scale-${Date.now()}`;
  const lines = [
    "Source Record Ref,Source Record ID,Vendor,Department,Owner Ref,Owner,Amount,Currency,Transaction Date,Document Number",
  ];
  for (let index = 1; index <= rowCount; index += 1) {
    const suffix = String(index).padStart(3, "0");
    lines.push(
      `${runId}:bill:${suffix},${runId}-bill-${suffix},Scale Vendor ${runId},Research,EMP-001,Ada Lovelace,${100 + index}.00,USD,${AS_OF},${runId}-${suffix}`,
    );
  }
  return lines.join("\n");
}

async function runVendorScale(page: Page, rowCount: number) {
  assert.equal(Number.isSafeInteger(rowCount) && rowCount > 0, true, "scale row count is positive");
  if (process.env.CSV_INSTALLED_SCALE_API === "1") {
    const endpoint = `${ORIGIN}/vendor/api/csv-workspace`;
    const workspace = await page.request.get(`${endpoint}/workspace?as_of=${AS_OF}`);
    assert.equal(workspace.status(), 200, "authenticated Vendor workspace read succeeded");
    const loadedWorkspace = await workspace.json();
    const csv = vendorScaleCsv(rowCount);
    await writeFile(path.join(OUTPUT, "source.csv"), csv);
    const startedAt = performance.now();
    const response = await page.request.post(`${endpoint}/turn?as_of=${AS_OF}`, {
      headers: { origin: ORIGIN },
      timeout: TURN_TIMEOUT_MS,
      data: {
        schemaRevisionId: loadedWorkspace.schemaRevisionId,
        csv,
        draft: { revision: 0, rows: [] },
        instruction:
          "Prepare all source rows for import, including related records. Preserve the source meaning and explain any assumptions or exclusions.",
      },
    });
    const responseText = await response.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = {
        ok: false,
        issues: [
          {
            code: "non_json_transport_response",
            message: `HTTP ${response.status()} (${response.headers()["content-type"] ?? "unknown content type"})`,
          },
        ],
      };
    }
    const measurement = {
      evidence: "authenticated-api-preparation-only",
      status: response.status(),
      sourceRows: rowCount,
      elapsedMs: Math.round(performance.now() - startedAt),
      preparedTransactions:
        result.draft?.rows.filter((row: WorkspaceRow) => row.modelId === "vendor_spend_transaction")
          .length ?? 0,
      metadata: result.metadata,
      ok: result.ok,
      explanation: result.explanation,
      issues: result.issues,
    };
    await writeFile(path.join(OUTPUT, "api-turn.json"), JSON.stringify(result, null, 2));
    await writeFile(
      path.join(OUTPUT, "api-measurement.json"),
      JSON.stringify(measurement, null, 2),
    );
    console.log(JSON.stringify(measurement));
    assert.equal(response.status(), 200, "authenticated scale turn HTTP status");
    assert.equal(result.ok, true, "scale preparation succeeded");
    assert.equal(
      measurement.preparedTransactions,
      rowCount,
      "scale preparation covers every source row",
    );
    return measurement;
  }
  await page.goto(`${ORIGIN}/vendor/data-import`, { waitUntil: "domcontentloaded" });
  try {
    await page.getByLabel("CSV import").waitFor({ timeout: 60_000 });
  } catch (error) {
    await page.screenshot({ path: path.join(OUTPUT, "scale-mount-failure.png") });
    throw new Error(
      `Vendor scale workspace did not mount: ${(await page.locator("body").innerText()).slice(0, 2000)}`,
      { cause: error },
    );
  }
  await page.getByLabel("Effective date").fill(AS_OF);
  const scaleCase = {
    ...CASES[1]!,
    filename: `vendor-scale-${rowCount}-${Date.now()}.csv`,
    editValue: `SCALE-HUMAN-${Date.now()}`,
  };
  const turn = await waitForTurn(page, scaleCase, () =>
    page.locator('input[type="file"]').setInputFiles({
      name: scaleCase.filename,
      mimeType: "text/csv",
      buffer: Buffer.from(vendorScaleCsv(rowCount)),
    }),
  );
  assert.equal(
    turn.draft.rows.filter((row) => row.modelId === "vendor_spend_transaction").length,
    rowCount,
    "scale agent prepared every transaction row",
  );
  const editedRow = await editTextCell(page, scaleCase, turn.draft);
  await page
    .getByLabel("Message the agent")
    .fill(
      "Attach the shared vendor to its Department and Owner from the source, creating any identity-safe related rows needed. Preserve every manual grid edit exactly.",
    );
  const refinedTurn = await waitForTurn(page, scaleCase, () =>
    page.getByRole("button", { name: "Send" }).click(),
  );
  const refinedEditedRow = refinedTurn.draft.rows.find((row) => row.rowId === editedRow.rowId);
  assert.ok(refinedEditedRow, "scale refinement retained the manually edited row");
  assert.equal(
    scalar(refinedEditedRow, scaleCase.editField),
    scaleCase.editValue,
    "scale refinement preserved the manual grid edit",
  );
  const scaleVendors = refinedTurn.draft.rows.filter((row) => row.modelId === "vendor");
  assert.equal(scaleVendors.length, 1, "scale agent prepared the shared Vendor once");
  assert.ok(relationId(scaleVendors[0]!, "department"), "scale Vendor retained Department");
  assert.ok(relationId(scaleVendors[0]!, "owner"), "scale Vendor retained Owner");
  const scaleVendorId = scaleVendors[0]!.recordId;
  assert.ok(
    refinedTurn.draft.rows
      .filter((row) => row.modelId === "vendor_spend_transaction")
      .every((row) => relationId(row, "vendor") === scaleVendorId),
    "every scale transaction references the one shared Vendor",
  );
  let saveRequests = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `${scaleCase.endpoint}/save`
    )
      saveRequests += 1;
  });
  await page.getByRole("button", { name: /^Save \d+ changes$/u }).click();
  await page.getByRole("heading", { name: "Import saved" }).waitFor({ timeout: 60_000 });
  assert.equal(saveRequests, 1, "scale flow used one atomic Save");
  await page.reload({ waitUntil: "domcontentloaded" });
  const historyItem = page.getByRole("button", { name: scaleCase.filename });
  await historyItem.waitFor({ timeout: 60_000 });
  assert.equal(await historyItem.count(), 1, "scale Save created one history entry");
  await historyItem.click();
  await page.getByText("Loading saved changes…").waitFor({ state: "hidden" });
  await page.getByText(scaleCase.editValue, { exact: true }).waitFor();
  return {
    app: "vendor-scale",
    artifactRows: rowCount,
    draftRows: turn.draft.rows.length,
    elapsedMs: turn.elapsedMs,
    metadata: turn.metadata,
    refinementElapsedMs: refinedTurn.elapsedMs,
    refinementMetadata: refinedTurn.metadata,
    saveRequests,
    manualEdit: scaleCase.editValue,
    filename: scaleCase.filename,
  };
}

await mkdir(OUTPUT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.CSV_WORKSPACE_BROWSER_CHANNEL ?? "chrome",
});
const results: unknown[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("response", (response) => {
    if (response.status() >= 400) {
      console.error(`HTTP ${response.status()} ${new URL(response.url()).pathname}`);
      void response
        .text()
        .then((body) => console.error(body.slice(0, 2_000)))
        .catch(() => undefined);
    }
  });
  await signIn(page);
  for (const app of CASES.filter(
    (candidate) => !SCALE_ONLY && (!APP_FILTER || candidate.name === APP_FILTER),
  )) {
    const suffix = `${Date.now()}-${app.name}`;
    results.push(
      await runInstalledApp(page, {
        ...app,
        filename: `${suffix}.csv`,
        editValue: `${app.editValue} ${suffix}`,
      }),
    );
  }
  if (SCALE_ROWS > 0 && (!APP_FILTER || APP_FILTER === "vendor")) {
    results.push(await runVendorScale(page, SCALE_ROWS));
  }
  await writeFile(path.join(OUTPUT, "result.json"), `${JSON.stringify({ results }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, results }));
} catch (error) {
  await writeFile(
    path.join(OUTPUT, "failure.json"),
    `${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser.close();
}
