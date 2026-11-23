import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import {
  createAmpersandReadIngress,
  AmpersandReadError,
  type AmpersandPayloadOptions,
  type AmpersandReadSubject,
} from "../ampersand-read";
import { createQuickBooksRecipe } from "../recipes/quickbooks";
import { createXeroRecipe } from "../recipes/xero";
import type { ActiveIntegrationBinding, IntegrationIdentity } from "../index";
import type { DataContext } from "../../generated-app-runtime/data";
import { definition } from "./quickbooks-fixture";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: transport.request }));

const seconds = 1792065600;
const secret = Buffer.from("synthetic-fixture-signing-key");
const identity = {
  appId: "app",
  customerId: "tenant",
  bindingId: "binding",
  connectionId: "connection",
  routingId: "route",
};
const binding: ActiveIntegrationBinding = {
  ...identity,
  actorId: "service",
  lifecycle: "active",
  bindingRevision: 2,
};
const qbo = createQuickBooksRecipe(definition, {
  id: "app.qbo",
  version: "1",
  vendors: { model: "supplier", name: "name", status: "status" },
});
const xero = createXeroRecipe(definition, {
  id: "app.xero",
  version: "1",
  suppliers: { model: "supplier", name: "name", status: "status" },
});
const supplier = {
  mappedFields: { source_record_id: "vendor-1", name: "Example", status: true },
  raw: { confidential: "unmapped-raw-value" },
};
function bytes(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      action: "read",
      projectId: "project",
      provider: "quickbooks",
      consumerRef: "consumer",
      groupRef: "untrusted-group",
      installationId: "installation",
      installationUpdateTime: "2026-10-15T11:00:00Z",
      operationId: "shared-operation",
      operationTime: "2026-10-15T12:00:00Z",
      objectName: "vendor",
      resultInfo: { type: "inline", numRecords: 1 },
      result: [supplier],
      ...overrides,
    }),
  );
}
function signed(raw: Uint8Array, id = "message-1", time = seconds) {
  const signature = createHmac("sha256", secret)
    .update(`${id}.${time}.`)
    .update(raw)
    .digest("base64");
  return new Request("https://app.invalid/ingress", {
    method: "POST",
    headers: { "svix-id": id, "svix-timestamp": String(time), "svix-signature": `v1,${signature}` },
  });
}
function setup(payload: Partial<AmpersandPayloadOptions> = {}) {
  const order: string[] = [];
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  const receipts = new Map<string, Record<string, unknown>>();
  const context: DataContext = {
    scope: { appId: "app", customerId: "tenant" },
    authorize: async () => undefined,
    transaction: async (run) =>
      run({
        actorId: "service",
        sourceKind: "integration",
        call: async (operation, input) => {
          if (operation === "kernel_resolve_source_identities") {
            if (!input.replay_only) return input;
            return receipts.get(String(input.idempotency_key)) ?? null;
          }
          calls.push({ operation, input });
          if (operation === "kernel_read_active_schema_revision")
            return { schema_revision_id: "1", schema: { version: "quickbooks-test-v1" } };
          receipts.set(String(input.idempotency_key), input);
          order.push("apply");
          return { id: 1, schema_revision_id: "1" };
        },
      }),
  };
  const fetchImpl = vi.fn(async () => {
    order.push("download");
    return new Response(JSON.stringify([supplier]), {
      headers: { "content-type": "application/json" },
    });
  });
  const options = {
    projectId: "project",
    provider: "quickbooks" as const,
    signingSecret: `whsec_${secret.toString("base64")}`,
    projection: qbo,
    nowSeconds: () => seconds,
    payload: {
      allowedHosts: ["payload.example.test"],
      resolveHost: async () => ["93.184.216.34"],
      fetchImpl,
      ...payload,
    },
    resolveIdentity: vi.fn(async (_subject: AmpersandReadSubject, _request: Request) => {
      order.push("resolve");
      return identity;
    }),
    verifyBinding: vi.fn(
      async (_identity: IntegrationIdentity, _subject: AmpersandReadSubject, _request: Request) => {
        order.push("authority");
        return binding;
      },
    ),
    withBindingLease: async <T>(
      _identity: unknown,
      run: (binding: ActiveIntegrationBinding) => Promise<T>,
    ) => {
      order.push("lease");
      return run(binding);
    },
    createDataContext: () => context,
  };
  return { options, order, calls, fetchImpl, ingest: createAmpersandReadIngress(options) };
}
const urlEnvelope = (overrides: Record<string, unknown> = {}) =>
  bytes({
    resultInfo: {
      type: "url",
      downloadUrl: "https://payload.example.test/object?signature=private-url-value",
      numRecords: 1,
    },
    result: undefined,
    ...overrides,
  });

test("valid signed inline read authenticates installed authority, leases apply, hashes exact raw bytes and discards unmapped raw data", async () => {
  const state = setup();
  const raw = bytes();
  await state.ingest(raw, signed(raw));
  expect(state.order).toEqual(["resolve", "authority", "lease", "authority", "lease", "apply"]);
  expect(state.fetchImpl).not.toHaveBeenCalled();
  expect(state.options.resolveIdentity.mock.calls[0]).toHaveLength(2);
  const subject = state.options.resolveIdentity.mock.calls[0]![0] as unknown as Record<
    string,
    unknown
  >;
  expect(subject).toMatchObject({
    projectId: "project",
    installationId: "installation",
    groupRef: "untrusted-group",
  });
  expect(subject).not.toHaveProperty("result");
  expect(subject).not.toHaveProperty("resultInfo");
  const applied = state.calls.at(-1)!.input;
  const write = (applied.writes as any[])[0];
  expect(write.provenance.payload_hash).toBe(createHash("sha256").update(raw).digest("hex"));
  expect(JSON.stringify(applied)).not.toContain("unmapped-raw-value");
});

test.each(["forged", "modified", "expired", "future", "missing"])(
  "%s signature cannot parse or resolve authority",
  async (mode) => {
    const state = setup();
    const raw = bytes();
    const req = signed(
      raw,
      "message",
      mode === "expired" ? seconds - 301 : mode === "future" ? seconds + 301 : seconds,
    );
    if (mode === "forged") req.headers.set("svix-signature", "v1,forged");
    if (mode === "missing") req.headers.delete("svix-id");
    const submitted =
      mode === "modified"
        ? bytes({ result: [] })
        : mode === "forged"
          ? Buffer.from("{invalid-json")
          : raw;
    await expect(state.ingest(submitted, req)).rejects.toMatchObject({ status: 401 });
    expect(state.options.resolveIdentity).not.toHaveBeenCalled();
    expect(state.options.verifyBinding).not.toHaveBeenCalled();
    expect(state.fetchImpl).not.toHaveBeenCalled();
  },
);

test("signature rotation candidates work and per-call raw bytes remain owned across async identity resolution", async () => {
  const state = setup();
  const raw = bytes();
  const req = signed(raw);
  req.headers.set("svix-signature", `v1,invalid ${req.headers.get("svix-signature")}`);
  state.options.resolveIdentity.mockImplementationOnce(async () => {
    raw.fill(0);
    return identity;
  });
  await state.ingest(raw, req);
  expect(state.calls.at(-1)?.operation).toBe("kernel_apply_change_set");
});

test("signed message identity distinguishes split chunks of one operation and keeps exact retries stable", async () => {
  const state = setup();
  const raw = bytes();
  await state.ingest(raw, signed(raw, "chunk-one"));
  const first = state.calls.at(-1)!.input.idempotency_key;
  await state.ingest(raw, signed(raw, "chunk-two"));
  expect(state.calls.at(-1)!.input.idempotency_key).not.toBe(first);
  await state.ingest(raw, signed(raw, "chunk-one"));
  expect(state.calls.at(-1)!.input.idempotency_key).toBe(first);
});

test.each([
  { action: "subscribe" },
  { action: "proxy" },
  { provider: "ramp" },
  { projectId: "foreign-project" },
  { objectName: "unsupported-object" },
])(
  "unsupported signed subject rejects before any authority/provider access: %j",
  async (override) => {
    const state = setup();
    const raw = bytes(override);
    await expect(state.ingest(raw, signed(raw))).rejects.toBeInstanceOf(AmpersandReadError);
    expect(state.options.resolveIdentity).not.toHaveBeenCalled();
    expect(state.fetchImpl).not.toHaveBeenCalled();
  },
);

test("URL payload is retrieved after installed authority and committed retries skip retrieval", async () => {
  const state = setup();
  const raw = urlEnvelope();
  const req = signed(raw);
  await state.ingest(raw, req);
  const first = state.calls.at(-1)!.input.idempotency_key;
  expect(state.order).toEqual([
    "resolve",
    "authority",
    "lease",
    "download",
    "authority",
    "lease",
    "apply",
  ]);
  state.fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 403 }));
  await state.ingest(raw, req);
  expect(state.fetchImpl).toHaveBeenCalledTimes(1);
  expect(state.calls.at(-1)!.input.idempotency_key).toBe(first);
  expect(JSON.stringify(state.calls)).not.toContain("private-url-value");
});

test("host denial and mismatched binding authority prevent URL retrieval and safe errors omit provider details", async () => {
  const state = setup();
  const raw = urlEnvelope();
  state.options.verifyBinding.mockRejectedValueOnce(
    Object.assign(new Error("secret-provider-url"), { code: "forbidden" }),
  );
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 403,
    message: "ampersand_authority_denied",
  });
  expect(state.fetchImpl).not.toHaveBeenCalled();
  state.options.verifyBinding.mockResolvedValueOnce({ ...binding, customerId: "foreign-tenant" });
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({ status: 403 });
  expect(state.fetchImpl).not.toHaveBeenCalled();
});

test.each([[], ["example.test"], ["other.example.test"]].map((allowedHosts) => ({ allowedHosts })))(
  "URL host has no implicit or suffix grant: %j",
  async ({ allowedHosts }) => {
    const state = setup({ allowedHosts });
    const raw = urlEnvelope();
    await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
      status: 400,
      code: "ampersand_payload_host_not_allowed",
    });
    expect(state.fetchImpl).not.toHaveBeenCalled();
    expect(state.options.verifyBinding).toHaveBeenCalledOnce();
  },
);

test.each([
  "127.0.0.1",
  "10.2.3.4",
  "169.254.169.254",
  "::1",
  "::ffff:127.0.0.1",
  "::127.0.0.1",
  "64:ff9b::7f00:1",
])("DNS result %s is rejected before transport", async (address) => {
  const state = setup({ resolveHost: async () => [address] });
  const raw = urlEnvelope();
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 400,
    code: "ampersand_payload_private_host",
  });
  expect(state.fetchImpl).not.toHaveBeenCalled();
});

test.each([
  "http://payload.example.test/object",
  "https://payload.example.test:8443/object",
  "https://username:password@payload.example.test/object",
])("unsafe signed payload URL %s is rejected without transport", async (downloadUrl) => {
  const state = setup();
  const raw = urlEnvelope({ resultInfo: { type: "url", downloadUrl } });
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({ status: 400 });
  expect(state.fetchImpl).not.toHaveBeenCalled();
});

test("downloaded provenance hashes the exact downloaded bytes and revalidates each allowed redirect", async () => {
  const download = Buffer.from(`  ${JSON.stringify([supplier])}\n`);
  const resolved: string[] = [];
  let calls = 0;
  const state = setup({
    allowedHosts: ["payload.example.test", "second.example.test"],
    resolveHost: async (host) => {
      resolved.push(host);
      return ["93.184.216.34"];
    },
    fetchImpl: async () =>
      ++calls === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://second.example.test/object" },
          })
        : new Response(download, { headers: { "content-type": "application/vnd.fixture+json" } }),
  });
  const raw = urlEnvelope();
  await state.ingest(raw, signed(raw));
  expect(resolved).toEqual(["payload.example.test", "second.example.test"]);
  expect((state.calls.at(-1)!.input.writes as any[])[0].provenance.payload_hash).toBe(
    createHash("sha256").update(download).digest("hex"),
  );
});

test("transport exceptions are safe retryable failures without retaining raw URLs", async () => {
  const state = setup({
    fetchImpl: async () => {
      throw new Error("provider-url?secret=private");
    },
  });
  const raw = urlEnvelope();
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 502,
    message: "ampersand_payload_fetch_failed",
  });
  expect(state.calls).toHaveLength(0);
});

test.each([200, 204])(
  "default HTTPS transport pins vetted DNS, retains TLS hostname, and handles status %s safely",
  async (status) => {
    transport.request.mockImplementationOnce(
      (
        _url: URL,
        options: {
          servername: string;
          headers: Record<string, string>;
          lookup(
            host: string,
            options: unknown,
            callback: (error: Error | null, address: string, family: number) => void,
          ): void;
        },
        respond: (
          incoming: PassThrough & { statusCode: number; headers: Record<string, string> },
        ) => void,
      ) => {
        expect(options.servername).toBe("payload.example.test");
        expect(options.headers).toEqual({ accept: "application/json" });
        options.lookup("payload.example.test", {}, (error, address, family) => {
          expect(error).toBeNull();
          expect(address).toBe("93.184.216.34");
          expect(family).toBe(4);
        });
        return Object.assign(new EventEmitter(), {
          end() {
            queueMicrotask(() => {
              const incoming = Object.assign(new PassThrough(), {
                statusCode: status,
                headers: { "content-type": "application/json" },
              });
              respond(incoming);
              if (status === 200) incoming.end(JSON.stringify([supplier]));
            });
          },
        });
      },
    );
    const state = setup();
    const { fetchImpl: _fixtureTransport, ...payload } = state.options.payload;
    const ingest = createAmpersandReadIngress({ ...state.options, payload });
    const raw = urlEnvelope();
    if (status === 200) await expect(ingest(raw, signed(raw))).resolves.toMatchObject({ id: 1 });
    else
      await expect(ingest(raw, signed(raw))).rejects.toMatchObject({
        status: 502,
        code: "ampersand_payload_invalid_json",
      });
  },
);

test("redirects are manual and a forbidden target cannot be fetched", async () => {
  const state = setup({
    fetchImpl: async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { location: "https://forbidden.example.test/private?token=secret" },
      });
    },
  });
  const raw = urlEnvelope();
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 400,
    message: "ampersand_payload_host_not_allowed",
  });
  expect(state.calls).toHaveLength(0);
});

test.each(["dns", "fetch", "stream"])("%s deadline is bounded and retryable", async (phase) => {
  const state = setup({
    timeoutMs: 5,
    ...(phase === "dns"
      ? { resolveHost: async () => new Promise<readonly string[]>(() => {}) }
      : {}),
    ...(phase === "fetch" ? { fetchImpl: async () => new Promise<Response>(() => {}) } : {}),
    ...(phase === "stream"
      ? {
          fetchImpl: async () =>
            new Response(new ReadableStream({ pull() {} }), {
              headers: { "content-type": "application/json" },
            }),
        }
      : {}),
  });
  const raw = urlEnvelope();
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 504,
    message: "ampersand_payload_timeout",
  });
  expect(state.calls).toHaveLength(0);
});

test("streamed payloads are size bounded and non-JSON responses are rejected", async () => {
  const raw = urlEnvelope();
  const large = setup({ maxBytes: 16 });
  await expect(large.ingest(raw, signed(raw))).rejects.toMatchObject({ status: 413 });
  const wrongType = setup({
    fetchImpl: async () =>
      new Response("private raw failure", { headers: { "content-type": "text/html" } }),
  });
  await expect(wrongType.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 415,
    message: "ampersand_payload_not_json",
  });
});

test.each([
  { resultInfo: { type: "inline", numRecords: 0 }, result: null },
  {
    resultInfo: { type: "url", numRecords: 0, downloadUrl: "https://not-allowed.invalid/never" },
    result: undefined,
  },
  { resultInfo: { type: "inline" }, result: [] },
])("empty verified read is a leased no-op: %j", async (empty) => {
  const state = setup();
  const raw = bytes(empty);
  await expect(state.ingest(raw, signed(raw))).resolves.toEqual({
    kind: "noop",
    reason: "no_eligible_records",
  });
  expect(state.order).toEqual(["resolve", "authority", "lease", "authority", "lease"]);
  expect(state.calls).toHaveLength(0);
  expect(state.fetchImpl).not.toHaveBeenCalled();
});

test("declared empty reads cannot conceal nonempty inline data", async () => {
  const state = setup();
  const raw = bytes({ resultInfo: { type: "inline", numRecords: 0 } });
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 400,
    code: "ampersand_record_count_mismatch",
  });
  expect(state.calls).toHaveLength(0);
});

test("Xero mapped read uses its typed recipe and preserves transient eligibility filters", async () => {
  const state = setup();
  const ingest = createAmpersandReadIngress({
    ...state.options,
    provider: "xero",
    projection: xero,
  });
  const raw = bytes({
    provider: "xero",
    objectName: "contacts",
    result: [
      {
        mappedFields: { source_record_id: "contact-1", name: "Supplier", status: "active" },
        fields: { IsSupplier: true },
        raw: { private: "discard" },
      },
    ],
  });
  await ingest(raw, signed(raw));
  expect(state.calls.at(-1)?.operation).toBe("kernel_apply_change_set");
  const skipped = bytes({
    provider: "xero",
    objectName: "contacts",
    result: [{ mappedFields: {}, fields: { IsSupplier: false } }],
  });
  await expect(ingest(skipped, signed(skipped, "filtered"))).resolves.toEqual({
    kind: "noop",
    reason: "no_eligible_records",
  });
});

test.each(["inline", "url"] as const)(
  "%s record-count mismatch rejects before canonical writes",
  async (type) => {
    const state = setup();
    const resultInfo = {
      type,
      numRecords: 2,
      ...(type === "url" ? { downloadUrl: "https://payload.example.test/object" } : {}),
    };
    const raw = type === "url" ? urlEnvelope({ resultInfo }) : bytes({ resultInfo });
    await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
      status: 400,
      code: "integration_invalid_records",
    });
    expect(state.calls).toEqual([]);
  },
);

test("redirects to non-default HTTPS ports reject before a second transport call", async () => {
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://payload.example.test:8443/object" },
      }),
  );
  const state = setup({ fetchImpl });
  const raw = urlEnvelope();
  await expect(state.ingest(raw, signed(raw))).rejects.toMatchObject({
    status: 400,
    code: "ampersand_payload_url_port",
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(state.calls).toEqual([]);
});
