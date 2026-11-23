import { expect, test } from "vitest";
import {
  createAmpersandInstallationAdapter,
  type AmpersandInstallationOptions,
} from "../ampersand-installation";

const binding = {
  id: "binding-a",
  appId: "app-a",
  connectionId: "connection-a",
  routingId: "route-a",
  revision: 1,
  lifecycle: "pending" as const,
};
const objects = {
  vendor: {
    objectName: "vendor",
    destination: "appWebhook",
    schedule: "0 * * * *",
    selectedFields: { Id: true, DisplayName: true },
    selectedFieldMappings: { source_record_id: "Id", name: "DisplayName" },
    selectedValueMappings: { status: { active: "enabled", inactive: "disabled" } },
  },
};
const input = { binding, externalConnectionId: "external-a", idempotencyKey: binding.routingId };
function harness() {
  const calls: {
    url: URL;
    method: string;
    body: Record<string, any> | undefined;
    headers: Headers;
    redirect: RequestRedirect | undefined;
  }[] = [];
  const claims = new Set<string>();
  let drained = 0;
  let rows: Record<string, any>[] = [];
  let post: "ok" | "timeout-after-create" | "timeout-before-create" | "failed" = "ok";
  let ignorePatch = false,
    drainFails = false,
    readbackMissing = false;
  const install = (route = binding.routingId, disabled = false, connectionId = "external-a") => ({
    id: `installation-${route}`,
    projectId: "project",
    integrationId: "integration",
    group: { groupRef: "group-a" },
    connection: { id: connectionId, projectId: "project", provider: "quickbooks" },
    config: {
      createdBy: `api:integration-route:${route}`,
      content: {
        provider: "quickbooks",
        read: { objects: { vendor: { ...objects.vendor, disabled } } },
      },
    },
  });
  const options: AmpersandInstallationOptions = {
    appId: "app-a",
    projectId: "project",
    integrationId: "integration",
    provider: "quickbooks",
    apiKey: "secret-never-report",
    readObjects: objects,
    resolveConnection: async () => ({ externalConnectionId: "external-a", groupRef: "group-a" }),
    hasAttemptedCreate: async (b) => claims.has(b.routingId),
    claimInitialCreate: async (b) => {
      if (claims.has(b.routingId)) return false;
      claims.add(b.routingId);
      return true;
    },
    drainAppJobs: async () => {
      drained++;
      if (drainFails) throw new Error("job-drain-failed");
    },
    fetch: async (url, init) => {
      const path = new URL(url instanceof Request ? url.url : url.toString());
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, any>) : undefined;
      calls.push({
        url: path,
        method,
        body,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
      });
      if (path.pathname.endsWith("/connections/external-a"))
        return Response.json({
          id: "external-a",
          projectId: "project",
          provider: "quickbooks",
          group: { groupRef: "group-a" },
          status: "working",
        });
      if (method === "POST") {
        if (post === "failed") return new Response("secret provider detail", { status: 500 });
        if (post === "timeout-before-create") throw new Error("sensitive timeout detail");
        const row = install();
        rows.push(row);
        if (post === "timeout-after-create") throw new Error("sensitive timeout detail");
        return Response.json(row, { status: 201 });
      }
      if (method === "PATCH") {
        const row = rows.find((r) => path.pathname.endsWith(`/installations/${r.id}`));
        if (!row) return new Response(null, { status: 404 });
        if (!ignorePatch)
          row.config.content.read.objects = body!.installation.config.content.read.objects;
        return Response.json(row);
      }
      if (path.pathname.endsWith("/installations")) return Response.json(rows);
      const row = rows.find((r) => path.pathname.endsWith(`/installations/${r.id}`));
      return row && !readbackMissing ? Response.json(row) : new Response(null, { status: 404 });
    },
  };
  return {
    options,
    calls,
    claims,
    install,
    get rows() {
      return rows;
    },
    set rows(value) {
      rows = value;
    },
    get drained() {
      return drained;
    },
    set post(value: typeof post) {
      post = value;
    },
    set ignorePatch(value: boolean) {
      ignorePatch = value;
    },
    set drainFails(value: boolean) {
      drainFails = value;
    },
    set readbackMissing(value: boolean) {
      readbackMissing = value;
    },
  };
}

test("creates only an exact existing connection, reconciles exact route and independently reads back", async () => {
  const h = harness();
  const adapter = createAmpersandInstallationAdapter(h.options);
  expect(await adapter.reconcile(input)).toEqual({ status: "absent" });
  expect(await adapter.create(input)).toEqual({ installationId: "installation-route-a" });
  expect(await adapter.reconcile(input)).toEqual({
    status: "present",
    installationId: "installation-route-a",
  });
  const create = h.calls.find((c) => c.method === "POST")!;
  expect(create.body).toEqual({
    groupRef: "group-a",
    connectionId: "external-a",
    config: {
      createdBy: "api:integration-route:route-a",
      content: {
        provider: "quickbooks",
        read: { objects: { vendor: { ...objects.vendor, disabled: false } } },
      },
    },
  });
  expect(create.headers.has("idempotency-key")).toBe(false);
  expect(
    h.calls.every(
      (c) => c.url.origin === "https://api.withampersand.com" && c.redirect === "error",
    ),
  ).toBe(true);
  expect(
    h.calls
      .filter((c) => c.url.pathname.endsWith("/installations") && c.method === "GET")
      .every((c) => c.url.search === "?groupRef=group-a"),
  ).toBe(true);
  expect(h.calls.some((c) => c.url.searchParams.has("includeCreds"))).toBe(false);
  expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("timeout after create adopts exact discovered installation without issuing another create", async () => {
  const h = harness();
  h.post = "timeout-after-create";
  const adapter = createAmpersandInstallationAdapter(h.options);
  await expect(adapter.create(input)).rejects.toThrow("ampersand_reconciliation_required");
  expect(await adapter.reconcile(input)).toEqual({
    status: "present",
    installationId: "installation-route-a",
  });
  await expect(adapter.create(input)).rejects.toThrow("ampersand_reconciliation_required");
  expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("timeout before create remains uncertain across adapter recreation, even if a list is empty", async () => {
  const h = harness();
  h.post = "timeout-before-create";
  await expect(createAmpersandInstallationAdapter(h.options).create(input)).rejects.toThrow(
    "ampersand_reconciliation_required",
  );
  const restarted = createAmpersandInstallationAdapter(h.options);
  expect(await restarted.reconcile(input)).toEqual({ status: "uncertain" });
  await expect(restarted.create(input)).rejects.toThrow("ampersand_reconciliation_required");
  expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("durable claim prevents concurrent duplicate creates without relying on remote uniqueness", async () => {
  const h = harness();
  const a = createAmpersandInstallationAdapter(h.options),
    b = createAmpersandInstallationAdapter(h.options);
  const results = await Promise.allSettled([a.create(input), b.create(input)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(1);
});

test("ambiguous failed response does not release claim or expose provider details", async () => {
  const h = harness();
  h.post = "failed";
  const adapter = createAmpersandInstallationAdapter(h.options);
  await expect(adapter.create(input)).rejects.toMatchObject({
    code: "reconciliation_required",
    message: "ampersand_reconciliation_required",
  });
  expect(await adapter.reconcile(input)).toEqual({ status: "uncertain" });
});

test("route identity is exact, unrelated route and shared-connection installations are retained", async () => {
  const h = harness();
  h.rows = [h.install("route-a-extra"), h.install("route-b")];
  const adapter = createAmpersandInstallationAdapter(h.options);
  expect(await adapter.reconcile(input)).toEqual({ status: "absent" });
  await adapter.create(input);
  expect(h.rows).toHaveLength(3);
  expect(h.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
});

test("wrong app, external connection, group, project and exact-marker collisions fail before mutation", async () => {
  for (const mutate of [
    (h: ReturnType<typeof harness>) => {
      h.rows[0]!.connection.id = "external-other";
    },
    (h: ReturnType<typeof harness>) => {
      h.rows[0]!.group.groupRef = "group-other";
    },
    (h: ReturnType<typeof harness>) => {
      h.rows[0]!.projectId = "project-other";
    },
  ]) {
    const h = harness();
    h.rows = [h.install()];
    mutate(h);
    await expect(createAmpersandInstallationAdapter(h.options).reconcile(input)).rejects.toThrow(
      "ampersand_scope_invalid",
    );
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  }
  const h = harness();
  const adapter = createAmpersandInstallationAdapter(h.options);
  await expect(
    adapter.create({ ...input, externalConnectionId: "external-other" }),
  ).rejects.toThrow("ampersand_scope_invalid");
  await expect(
    adapter.reconcile({ ...input, binding: { ...binding, appId: "app-other" } }),
  ).rejects.toThrow("ampersand_scope_invalid");
  expect(h.calls).toHaveLength(0);
});

test("duplicate exact routes and missing readback are uncertain and never activate", async () => {
  const h = harness();
  h.rows = [h.install(), { ...h.install(), id: "duplicate" }];
  const adapter = createAmpersandInstallationAdapter(h.options);
  expect(await adapter.reconcile(input)).toEqual({ status: "uncertain" });
  h.rows = [h.install()];
  h.readbackMissing = true;
  expect(await adapter.reconcile(input)).toEqual({ status: "uncertain" });
});

test("removal disables scheduled AND on-demand reads, drains jobs, verifies tombstone and preserves connection", async () => {
  const h = harness();
  h.rows = [h.install(), h.install("other-route")];
  const adapter = createAmpersandInstallationAdapter(h.options);
  await adapter.stopAndRemove({ ...binding, lifecycle: "suspending" });
  expect(h.drained).toBe(1);
  expect(h.rows[0]!.config.content.read.objects.vendor.disabled).toBe(true);
  expect(h.rows[1]!.config.content.read.objects.vendor.disabled).toBe(false);
  const patch = h.calls.find((c) => c.method === "PATCH")!;
  expect(patch.body!.updateMask).toEqual(["config.content.read.objects.vendor"]);
  expect(h.calls.at(-1)!.method).toBe("GET");
  expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  await adapter.stopAndRemove({ ...binding, lifecycle: "suspending" });
  expect(h.calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
  expect(await adapter.reconcile(input)).toEqual({
    status: "present",
    installationId: "installation-route-a",
  });
  expect(h.rows[0]!.config.content.read.objects.vendor.disabled).toBe(false);
});

test("ineffective disable, missing installation and app-job drain failure cannot acknowledge removal", async () => {
  for (const mode of ["ignored", "missing", "jobs"]) {
    const h = harness();
    h.rows = mode === "missing" ? [] : [h.install()];
    if (mode === "missing") h.claims.add(binding.routingId);
    h.ignorePatch = mode === "ignored";
    h.drainFails = mode === "jobs";
    await expect(
      createAmpersandInstallationAdapter(h.options).stopAndRemove({
        ...binding,
        lifecycle: "suspending",
      }),
    ).rejects.toThrow();
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  }
});

test("unsupported remote proxy, subscriptions, writes, changed mappings and unknown read effects fail closed", async () => {
  for (const extra of [
    { proxy: { enabled: true } },
    { subscribe: { objects: { vendor: {} } } },
    { write: { objects: { vendor: {} } } },
    {
      read: {
        objects: { vendor: { ...objects.vendor, selectedFieldMappings: { name: "DisplayName" } } },
      },
    },
    { read: { objects: { vendor: { ...objects.vendor }, unknown: { objectName: "other" } } } },
  ]) {
    const h = harness();
    h.rows = [h.install()];
    Object.assign(h.rows[0]!.config.content, extra);
    await expect(createAmpersandInstallationAdapter(h.options).reconcile(input)).rejects.toThrow(
      "ampersand_configuration_unsupported",
    );
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  }
  const h = harness();
  expect(() => createAmpersandInstallationAdapter({ ...h.options, readObjects: {} })).toThrow(
    "ampersand_configuration_unsupported",
  );
  expect(() =>
    createAmpersandInstallationAdapter({
      ...h.options,
      readObjects: { "vendor.unsafe": objects.vendor },
    }),
  ).toThrow("ampersand_configuration_unsupported");
});

test("malformed or oversized provider response never means absent", async () => {
  for (const response of [
    Response.json({ items: [] }),
    Response.json([{}]),
    new Response("x".repeat(524289)),
  ]) {
    const h = harness();
    const fetcher = h.options.fetch!;
    h.options.fetch = async (url, init) =>
      (url instanceof Request ? url.url : url.toString()).includes("/connections/")
        ? fetcher(url, init)
        : response;
    expect(await createAmpersandInstallationAdapter(h.options).reconcile(input)).toEqual({
      status: "uncertain",
    });
  }
});

test("absent installations with no create attempt drain jobs and acknowledge removal", async () => {
  const h = harness();
  await createAmpersandInstallationAdapter(h.options).stopAndRemove({
    ...binding,
    lifecycle: "suspending",
  });
  expect(h.drained).toBe(1);
  expect(h.calls.some((call) => call.method !== "GET")).toBe(false);
  h.drainFails = true;
  await expect(
    createAmpersandInstallationAdapter(h.options).stopAndRemove({
      ...binding,
      lifecycle: "suspending",
    }),
  ).rejects.toThrow("job-drain-failed");
});
