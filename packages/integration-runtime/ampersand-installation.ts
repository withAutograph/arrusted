import type { IntegrationBinding as Binding } from "../contracts/integrations";

/** App-owned provider operations scoped to the exact route, tenant and connection. */
export type AppInstallationAdapter = {
  reconcile(input: {
    externalConnectionId: string;
    binding: Binding;
  }): Promise<
    { status: "present"; installationId: string } | { status: "absent" } | { status: "uncertain" }
  >;
  create(input: {
    externalConnectionId: string;
    binding: Binding;
    idempotencyKey: string;
  }): Promise<{ installationId: string }>;
  /** Stop and drain admitted work, then independently verify disabled/absent state.
   * A paused tombstone preserves connections shared with other installations. */
  stopAndRemove(binding: Binding): Promise<void>;
};
type JsonObject = { [key: string]: unknown };
export type AmpersandReadObject = {
  objectName: string;
  destination: string;
  schedule?: string;
  selectedFields?: Readonly<Record<string, boolean>>;
  selectedFieldMappings?: Readonly<Record<string, string>>;
  selectedValueMappings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
};

/** An independently committed, durable, atomic one-shot journal, shared across
 * processes. A failed provider call MUST NOT roll back its claim. Ampersand's
 * public create API documents no idempotency key or route uniqueness guarantee.
 * Keep claims for the lifetime of the routing identity, including after removal. */
export type AmpersandInstallationOptions = {
  appId: string;
  projectId: string;
  integrationId: string;
  provider: string;
  apiKey: string;
  /** Scheduled raw or explicitly mapped reads are supported. Proxy, writes and provider
   * subscriptions require another adapter with its own stop/readback proof. */
  readObjects: Readonly<Record<string, AmpersandReadObject>>;
  resolveConnection(binding: Binding): Promise<{ externalConnectionId: string; groupRef: string }>;
  hasAttemptedCreate(binding: Binding): Promise<boolean>;
  claimInitialCreate(binding: Binding): Promise<boolean>;
  /** Stop admission, then drain/abort all app-owned jobs for this route. Must be
   * idempotent. Central authority has already fenced ingestion before this runs. */
  drainAppJobs(binding: Binding): Promise<void>;
  fetch?: typeof globalThis.fetch;
};

export class AmpersandInstallationError extends Error {
  constructor(
    readonly code:
      | "scope_invalid"
      | "configuration_unsupported"
      | "provider_unavailable"
      | "reconciliation_required",
  ) {
    super(`ampersand_${code}`);
    this.name = "AmpersandInstallationError";
  }
}
const fail = (code: AmpersandInstallationError["code"]): never => {
  throw new AmpersandInstallationError(code);
};
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("reconciliation_required");
  return value as JsonObject;
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 512 ||
    value.split("").some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail("scope_invalid");
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Concrete server-only REST adapter. Exact groupRef is a documented provider
 * query; routes match exact createdBy markers, never customer/prefix scans.
 * https://docs.ampersand.ai/reference/installation/list-installations-for-an-integration
 * https://docs.ampersand.ai/reference/installation/create-a-new-installation
 * https://docs.ampersand.ai/reference/installation/update-an-installation
 *
 * Removal is a verified disabled-read tombstone, NOT DELETE: Ampersand deletes
 * the shared connection when deleting its last installation. In-flight webhook
 * delivery can still arrive; central binding authority must reject it.
 * https://docs.ampersand.ai/reference/installation/delete-an-installation */
export function createAmpersandInstallationAdapter(
  options: AmpersandInstallationOptions,
): AppInstallationAdapter {
  if (typeof window !== "undefined") throw new Error("ampersand_server_only");
  options = { ...options };
  for (const value of [
    options.appId,
    options.projectId,
    options.integrationId,
    options.provider,
    options.apiKey,
  ])
    id(value);
  const entries = Object.entries(options.readObjects);
  if (!entries.length || entries.length > 100) return fail("configuration_unsupported");
  const readObjects: JsonObject = Object.create(null) as JsonObject;
  for (const [name, input] of entries) {
    // Object names enter field-mask paths. Reject dots and unsupported config,
    // including executable expressions or active provider-side effects.
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(name) ||
      !input ||
      Object.keys(input).some(
        (k) =>
          ![
            "objectName",
            "destination",
            "schedule",
            "selectedFields",
            "selectedFieldMappings",
            "selectedValueMappings",
          ].includes(k),
      )
    )
      return fail("configuration_unsupported");
    id(input.objectName);
    id(input.destination);
    if (input.schedule !== undefined) id(input.schedule);
    for (const map of [
      input.selectedFields,
      input.selectedFieldMappings,
      input.selectedValueMappings,
    ]) {
      if (map !== undefined && (!map || typeof map !== "object" || Array.isArray(map)))
        return fail("configuration_unsupported");
    }
    if (
      input.selectedFields &&
      (Object.keys(input.selectedFields).length > 1000 ||
        Object.entries(input.selectedFields).some(
          ([k, v]) => !k.length || k.length > 512 || typeof v !== "boolean",
        ))
    )
      return fail("configuration_unsupported");
    if (input.selectedFieldMappings) {
      if (Object.keys(input.selectedFieldMappings).length > 1000)
        return fail("configuration_unsupported");
      for (const [target, source] of Object.entries(input.selectedFieldMappings)) {
        id(target);
        id(source);
      }
    }
    if (input.selectedValueMappings) {
      if (Object.keys(input.selectedValueMappings).length > 1000)
        return fail("configuration_unsupported");
      for (const [target, values] of Object.entries(input.selectedValueMappings)) {
        id(target);
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.keys(values).length > 1000
        )
          return fail("configuration_unsupported");
        for (const [destination, source] of Object.entries(values)) {
          id(destination);
          id(source);
        }
      }
    }
    readObjects[name] = structuredClone({ ...input, disabled: false });
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = `https://api.withampersand.com/v1/projects/${encodeURIComponent(options.projectId)}/integrations/${encodeURIComponent(options.integrationId)}/installations`;
  const marker = (binding: Binding) => `api:integration-route:${id(binding.routingId)}`;
  async function request(url: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method,
        headers: { "x-api-key": options.apiKey, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail("provider_unavailable");
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      await response.body?.cancel();
      return fail("provider_unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) return fail("reconciliation_required");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 524288) {
          await reader.cancel();
          return fail("reconciliation_required");
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return fail("reconciliation_required");
    }
  }
  async function scope(binding: Binding, externalConnectionId?: string) {
    if (binding.appId !== options.appId) return fail("scope_invalid");
    id(binding.id);
    id(binding.connectionId);
    marker(binding);
    const resolved = await options.resolveConnection(binding);
    id(resolved.externalConnectionId);
    id(resolved.groupRef);
    if (
      externalConnectionId !== undefined &&
      resolved.externalConnectionId !== externalConnectionId
    )
      return fail("scope_invalid");
    // Never request includeCreds. Check the exact existing connection before any
    // install operation, so activation cannot create or switch a connection.
    const connection = object(
      await request(
        `https://api.withampersand.com/v1/projects/${encodeURIComponent(options.projectId)}/connections/${encodeURIComponent(resolved.externalConnectionId)}`,
      ),
    );
    if (
      connection.id !== resolved.externalConnectionId ||
      connection.projectId !== options.projectId ||
      connection.provider !== options.provider ||
      object(connection.group).groupRef !== resolved.groupRef ||
      !["created", "working"].includes(String(connection.status))
    )
      return fail("scope_invalid");
    return resolved;
  }
  function validate(
    row: unknown,
    binding: Binding,
    connection: { externalConnectionId: string; groupRef: string },
    installationId?: string,
  ): JsonObject {
    const installation = object(row);
    id(installation.id);
    if (
      (installationId !== undefined && installation.id !== installationId) ||
      installation.projectId !== options.projectId ||
      installation.integrationId !== options.integrationId ||
      object(installation.group).groupRef !== connection.groupRef
    )
      return fail("scope_invalid");
    const installedConnection = object(installation.connection);
    if (
      installedConnection.id !== connection.externalConnectionId ||
      installedConnection.provider !== options.provider ||
      installedConnection.projectId !== options.projectId
    )
      return fail("scope_invalid");
    const config = object(installation.config);
    if (config.createdBy !== marker(binding)) return fail("scope_invalid");
    const content = object(config.content);
    if (
      content.provider !== options.provider ||
      Object.keys(content).some(
        (k) => !["provider", "read", "write", "subscribe", "proxy"].includes(k),
      )
    )
      return fail("configuration_unsupported");
    for (const kind of ["write", "subscribe"])
      if (content[kind] !== undefined && canonical(content[kind]) !== canonical({ objects: {} }))
        return fail("configuration_unsupported");
    if (content.proxy !== undefined && canonical(content.proxy) !== canonical({ enabled: false }))
      return fail("configuration_unsupported");
    const read = object(content.read);
    if (Object.keys(read).some((k) => k !== "objects")) return fail("configuration_unsupported");
    const remote = object(read.objects);
    if (canonical(Object.keys(remote).sort()) !== canonical(Object.keys(readObjects).sort()))
      return fail("configuration_unsupported");
    for (const [name, expected] of Object.entries(readObjects)) {
      const actual = object(remote[name]);
      if (actual.disabled !== undefined && typeof actual.disabled !== "boolean")
        return fail("configuration_unsupported");
      if (canonical({ ...actual, disabled: false }) !== canonical(expected))
        return fail("configuration_unsupported");
    }
    return remote;
  }
  async function find(
    binding: Binding,
    connection: { externalConnectionId: string; groupRef: string },
  ) {
    const rows = await request(`${base}?groupRef=${encodeURIComponent(connection.groupRef)}`);
    if (!Array.isArray(rows) || rows.length > 1000) return fail("reconciliation_required");
    // Malformed rows are not silently skipped: absence must be established.
    const candidates = rows.filter((row) => {
      const value = object(row);
      if (
        object(value.group).groupRef !== connection.groupRef ||
        value.projectId !== options.projectId ||
        value.integrationId !== options.integrationId
      )
        return fail("scope_invalid");
      return object(value.config).createdBy === marker(binding);
    });
    if (candidates.length > 1) return fail("reconciliation_required");
    if (!candidates.length) return null;
    validate(candidates[0], binding, connection);
    return id(object(candidates[0]).id);
  }
  async function setDisabled(
    binding: Binding,
    connection: { externalConnectionId: string; groupRef: string },
    installationId: string,
    disabled: boolean,
  ) {
    const path = `${base}/${encodeURIComponent(installationId)}`;
    const current = await request(path);
    if (current === null) return fail("reconciliation_required");
    const remote = validate(current, binding, connection, installationId);
    if (Object.values(remote).some((value) => (object(value).disabled ?? false) !== disabled)) {
      const objects = Object.fromEntries(
        Object.entries(readObjects).map(([k, v]) => [k, { ...object(v), disabled }]),
      );
      await request(`${path}?skipSampling=true`, "PATCH", {
        updateMask: Object.keys(objects).map((k) => `config.content.read.objects.${k}`),
        installation: { config: { content: { read: { objects } } } },
      });
    }
    const verified = validate(await request(path), binding, connection, installationId);
    if (Object.values(verified).some((value) => (object(value).disabled ?? false) !== disabled))
      return fail("reconciliation_required");
  }
  return {
    async reconcile({ binding, externalConnectionId }) {
      if (binding.lifecycle !== "pending") return fail("scope_invalid");
      const connection = await scope(binding, externalConnectionId);
      try {
        const installationId = await find(binding, connection);
        if (!installationId)
          return (await options.hasAttemptedCreate(binding))
            ? { status: "uncertain" }
            : { status: "absent" };
        await setDisabled(binding, connection, installationId, false);
        return { status: "present", installationId };
      } catch (error) {
        if (
          error instanceof AmpersandInstallationError &&
          ["reconciliation_required", "provider_unavailable"].includes(error.code)
        )
          return { status: "uncertain" };
        throw error;
      }
    },
    async create({ binding, externalConnectionId, idempotencyKey }) {
      if (binding.lifecycle !== "pending" || idempotencyKey !== binding.routingId)
        return fail("scope_invalid");
      const connection = await scope(binding, externalConnectionId);
      // Recheck exact remote route before the durable claim, including direct
      // callers bypassing reconcile. Never forward a fictional idempotency key.
      if ((await find(binding, connection)) !== null) return fail("reconciliation_required");
      if (!(await options.claimInitialCreate(binding))) return fail("reconciliation_required");
      try {
        const result = object(
          await request(`${base}?skipSampling=true`, "POST", {
            groupRef: connection.groupRef,
            connectionId: connection.externalConnectionId,
            config: {
              createdBy: marker(binding),
              content: { provider: options.provider, read: { objects: readObjects } },
            },
          }),
        );
        validate(result, binding, connection);
        const installationId = id(result.id);
        await setDisabled(binding, connection, installationId, false);
        return { installationId };
      } catch {
        return fail("reconciliation_required");
      }
    },
    async stopAndRemove(binding) {
      if (binding.lifecycle !== "suspending") return fail("scope_invalid");
      const connection = await scope(binding);
      const installationId = await find(binding, connection);
      if (!installationId) {
        if (await options.hasAttemptedCreate(binding)) return fail("reconciliation_required");
        await options.drainAppJobs(binding);
        return;
      }
      await setDisabled(binding, connection, installationId, true);
      await options.drainAppJobs(binding);
      // Independent readback follows both provider and app-owned stopping.
      const verified = validate(
        await request(`${base}/${encodeURIComponent(installationId)}`),
        binding,
        connection,
        installationId,
      );
      if (Object.values(verified).some((value) => object(value).disabled !== true))
        return fail("reconciliation_required");
    },
  };
}
