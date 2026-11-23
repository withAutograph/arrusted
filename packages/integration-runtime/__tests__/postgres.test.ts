import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, test } from "vitest";
import { createPostgresDataContext } from "../../generated-app-runtime/postgres";
import { createDataClient } from "../../generated-app-runtime/data";
import {
  createIntegrationIngress,
  defineIntegrationRecipe,
  type ActiveIntegrationBinding,
} from "../index";
import { definition as typedDefinition } from "./quickbooks-fixture";
import {
  createQuickBooksRecipe,
  type QuickBooksMappedRecord,
  type QuickBooksReadEnvelope,
} from "../recipes/quickbooks";

/** Real envelope -> typed recipe -> generated validation -> scoped SQL -> receipt. */
test.skipIf(!process.env.INTEGRATION_TEST_DATABASE_URL)(
  "QuickBooks ingestion persists and replays through generated PostgreSQL runtime",
  async () => {
    const admin = new Pool({ connectionString: process.env.INTEGRATION_TEST_DATABASE_URL });
    const database = `integration_quickbooks_${randomUUID().replaceAll("-", "")}`;
    const inputs = [
      "packages/schema-compiler/cue/app-manifest.cue",
      "packages/integration-runtime/__tests__/quickbooks.cue",
    ];
    const compiler = (flag: string) =>
      execFileSync("cargo", ["run", "--quiet", "-p", "schema-compiler", "--", flag, ...inputs], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      });
    const bundle = compiler("--sql-bundle");
    const artifact = JSON.parse(compiler("--app-artifact"));
    const definition = JSON.parse(compiler("--data-plane")).manifest as typeof typedDefinition;
    const url = new URL(process.env.INTEGRATION_TEST_DATABASE_URL!);
    url.pathname = `/${database}`;
    const owner = new Pool({ connectionString: url.toString() });
    const runtimeName = `ingestion_${randomUUID().replaceAll("-", "")}`;
    const runtimePassword = `fixture-${randomUUID()}`;
    let runtime: Pool | undefined;
    let roles: string[] = [];
    try {
      await admin.query(`create database "${database}"`);
      await owner.query(bundle);
      roles = (
        await owner.query(
          "select kernel_installer_capability_role(capability) name from unnest(array['query','runtime','schema_admin','execution_owner']) capability",
        )
      ).rows.map((row) => String(row.name));
      const runtimeRole = (
        await owner.query("select kernel_installer_capability_role('runtime') name")
      ).rows[0].name;
      await owner.query(
        `grant "${runtimeRole}" to session_user; create role "${runtimeName}" login password '${runtimePassword}' nosuperuser nobypassrls; grant "${runtimeRole}" to "${runtimeName}"`,
      );
      await owner.query(
        "insert into schema_revision(app_id,customer_id,version,base_schema,customer_overlay,schema,activated_at) values('integration-quickbooks','tenant-a','quickbooks-test-v1',$1,'{}'::jsonb,$1,now())",
        [artifact.schema],
      );
      await owner.query("select kernel_bind_principal_scope($1::jsonb)", [
        JSON.stringify({
          principal_name: runtimeName,
          capability: "runtime",
          app_id: "integration-quickbooks",
          customer_id: "tenant-a",
        }),
      ]);
      url.username = runtimeName;
      url.password = runtimePassword;
      runtime = new Pool({ connectionString: url.toString() });
      const binding: ActiveIntegrationBinding = {
        appId: "integration-quickbooks",
        customerId: "tenant-a",
        bindingId: "binding",
        connectionId: "connection",
        routingId: "route",
        lifecycle: "active",
        bindingRevision: 1,
        actorId: "service",
      };
      await owner.query("select kernel_bind_actor_membership($1::jsonb)", [
        JSON.stringify({
          principal_name: runtimeName,
          app_id: binding.appId,
          customer_id: binding.customerId,
          actor_id: binding.actorId,
          role: "importer",
          actor_kind: "service",
        }),
      ]);
      const context = createPostgresDataContext({
        pool: runtime,
        appId: binding.appId,
        customerId: binding.customerId,
        actorId: binding.actorId,
        sourceKind: "integration",
        authorize: async () => {},
        verifyRelease: () => {},
      });
      const projected = createQuickBooksRecipe(definition, {
        id: "integration-quickbooks.quickbooks.apply",
        version: "v1",
        vendors: { model: "supplier", name: "name", status: "status", entityName: "entity" },
        payables: {
          model: "payable",
          vendor: "vendor",
          amount: "amount",
          currencyCode: "currency",
          transactionDate: "date",
          sourceUpdatedAt: "updated",
          transactionKind: "kind",
        },
      });
      type Envelope = QuickBooksReadEnvelope & { records: QuickBooksMappedRecord[] };
      const ingress = createIntegrationIngress({
        projection: projected,
        verifySignature: async () => {},
        parseEnvelope: (raw: Uint8Array): Envelope => JSON.parse(Buffer.from(raw).toString()),
        verifyBinding: async () => binding,
        withBindingLease: async <T>(
          _identity: unknown,
          run: (authority: ActiveIntegrationBinding) => Promise<T>,
        ) => run(binding),
        parseRecords: (_raw: Uint8Array, envelope: QuickBooksReadEnvelope) =>
          (envelope as Envelope).records,
        createDataContext: () => context,
      });
      const delivery = (
        object: string,
        id: string,
        records: QuickBooksMappedRecord[],
        operationTime = "2026-10-15T12:00:00Z",
      ) =>
        Buffer.from(
          JSON.stringify({
            identity: { ...binding, deliveryId: id },
            object,
            provider: "quickbooks",
            installationId: "installation",
            operationTime,
            records,
          }),
        );
      const legacyId = randomUUID();
      // Simulate the legacy bridge with its now explicitly provisioned service
      // membership; superuser SQL without an authenticated actor is not ingress.
      const legacy = await context.transaction((session) =>
        session.call("kernel_apply_change_set", {
          app_id: binding.appId,
          customer_id: binding.customerId,
          actor_id: binding.actorId,
          source_kind: "integration",
          source_ref: "legacy-delivery",
          idempotency_key: "legacy-delivery",
          mode: "mainline",
          writes: [
            {
              model_id: "supplier",
              new_record_id: legacyId,
              effective_start: "2026-10-14",
              values: {
                name: { type: "text", value: "Legacy name" },
                status: { type: "enum", value: "active" },
              },
              provenance: { source_record_ref: "quickbooks:vendor:installation:vendor-1" },
            },
          ],
        }),
      );
      expect(legacy).toMatchObject({ id: expect.any(Number) });
      const vendor = delivery("vendor", "operation:chunk-1", [
        {
          mappedFields: {
            source_record_id: "vendor-1",
            name: "Acme",
            status: true,
            entity_name: "Acme Inc",
          },
        },
      ]);
      const first = await ingress(vendor, undefined);
      expect(await ingress(vendor, undefined)).toEqual(first);
      const bill = delivery("bill", "operation:chunk-2", [
        {
          mappedFields: {
            source_record_id: "bill-1",
            vendor_source_record_id: "vendor-1",
            amount: "9007199254740993.125",
            currency_code: "usd",
            transaction_date: "2026-10-15",
            source_updated_at: "2026-10-15T12:00:00Z",
          },
        },
      ]);
      await ingress(bill, undefined);
      const operations = createDataClient(definition, context);
      const migrated = await operations.supplier.list({ asOf: "2026-10-15" });
      expect(migrated).toHaveLength(1);
      expect(migrated[0]!.id).toBe(legacyId);
      const payables = await operations.payable.list({ asOf: "2026-10-15" });
      expect(payables).toHaveLength(1);
      expect(payables[0]).toMatchObject({
        amount: "9007199254740993.125",
        currency: "USD",
        kind: "bill",
      });
      const update = delivery(
        "vendor",
        "later:chunk-1",
        [
          {
            mappedFields: {
              source_record_id: "vendor-1",
              name: "Renamed",
              status: true,
              entity_name: "Acme Inc",
            },
          },
        ],
        "2026-10-16T12:00:00Z",
      );
      await ingress(update, undefined);
      expect(await ingress(vendor, undefined)).toEqual(first);
      const companies = await operations.supplier.list({ asOf: "2026-10-16" });
      expect(companies).toHaveLength(1);
      expect(companies[0]!.name).toBe("Renamed");
      await expect(
        ingress(
          delivery("vendor", "operation:chunk-1", [
            { mappedFields: { source_record_id: "vendor-1", name: "Conflicting", status: true } },
          ]),
          undefined,
        ),
      ).rejects.toMatchObject({ envelope: { code: "idempotency_conflict" } });
      const datedProjection = defineIntegrationRecipe<
        typeof definition,
        QuickBooksMappedRecord,
        QuickBooksReadEnvelope
      >(definition, {
        ...projected.recipe,
        projections: {
          supplier: {
            ...projected.recipe.projections.supplier!,
            effectiveStart: (record) => String(record.mappedFields.accounting_date),
          },
        },
      });
      const datedIngress = createIntegrationIngress({
        projection: datedProjection,
        verifySignature: async () => {},
        parseEnvelope: (raw: Uint8Array): Envelope => JSON.parse(Buffer.from(raw).toString()),
        verifyBinding: async () => binding,
        withBindingLease: async <T>(
          _identity: unknown,
          run: (authority: ActiveIntegrationBinding) => Promise<T>,
        ) => run(binding),
        parseRecords: (_raw: Uint8Array, envelope: QuickBooksReadEnvelope) =>
          (envelope as Envelope).records,
        createDataContext: () => context,
      });
      await datedIngress(
        delivery("vendor", "mixed-record-dates", [
          {
            mappedFields: {
              source_record_id: "dated-1",
              name: "Earlier",
              status: true,
              accounting_date: "2026-10-10",
            },
          },
          {
            mappedFields: {
              source_record_id: "dated-2",
              name: "Later",
              status: true,
              accounting_date: "2026-10-11",
            },
          },
        ]),
        undefined,
      );
      expect(
        (await operations.supplier.list({ asOf: "2026-10-10" })).map((record) => record.name),
      ).toEqual(["Earlier"]);
      expect(
        (await operations.supplier.list({ asOf: "2026-10-11" }))
          .map((record) => record.name)
          .sort(),
      ).toEqual(["Earlier", "Later"]);
      const persisted = (
        await owner.query(
          "select provenance from supplier_version where provenance ? 'payload_hash' limit 1",
        )
      ).rows[0].provenance;
      expect(persisted.source_record_ref).toMatch(/^quickbooks:vendor:installation:/);
      expect(persisted.payload_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(persisted)).not.toContain("mappedFields");
    } finally {
      await runtime?.end();
      await owner.end();
      await admin.query(`drop database if exists "${database}"`);
      await admin.query(`drop role if exists "${runtimeName}"`);
      for (const role of roles) await admin.query(`drop role if exists "${role}"`);
      await admin.end();
    }
  },
  120000,
);
