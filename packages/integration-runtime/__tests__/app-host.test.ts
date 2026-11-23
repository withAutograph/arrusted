import { describe, expect, test } from "vitest";
import { createAppIntegrationHost } from "../app-host";
import { defineAppIntegrations } from "../app-definition";

function fixture(appIntegrationKey = "quickbooks") {
  const schema = {
    formatVersion: 1,
    schemaVersion: "v1",
    models: [
      {
        id: "supplier",
        name: "supplier",
        relations: [],
        fields: [{ id: "n", name: "name", type: "text", readOnly: false, required: true }],
      },
    ],
  } as const;
  const definition = defineAppIntegrations(schema, {
    appId: "spend",
    hostModule: "app/integrations/host.ts",
    providers: [
      {
        provider: "quickbooks",
        recipe: {
          definition: schema,
          recipe: {
            id: "spend.quickbooks",
            version: "1",
            projections: { supplier: { fields: ["name"], normalize() {}, sourceReference() {} } },
          },
        },
      },
    ],
  });
  const connection = {
    id: "own-connection",
    provider: "quickbooks",
    lifecycle: "connected",
    revision: 1,
  } as const;
  const binding = {
    id: "own-binding",
    connectionId: connection.id,
    appId: "spend",
    routingId: "private-route",
    appIntegrationKey,
    actorId: "test-actor",
    lifecycle: "active",
    revision: 1,
  } as const;
  const events: string[] = [];
  const host = createAppIntegrationHost({
    definition,
    request: async () => {
      events.push("authenticate");
      return new Request("https://test.local");
    },
    control: {
      list: async () => ({ connections: [connection], bindings: [binding] }),
      registerConnection: async () => connection,
    },
    authorize: async (_request, action) => {
      events.push(`authorize:${action.kind}`);
      return action.values?.forbidden !== "yes";
    },
    providers: {
      quickbooks: {
        name: "QuickBooks",
        description: "Supplier records",
        ingress: async (raw) => {
          events.push(`ingress:${raw[0]}`);
        },
        installations: {
          activate: async () => {
            events.push("activate");
            return binding;
          },
          activateGrant: async (_request, input) => {
            events.push(
              `activate-grant:${input.appIntegrationKey}:${input.providerKey}:${input.grant}`,
            );
            return binding;
          },
          disable: async (_request, current) => {
            events.push(`disable:${current.id}`);
            return { ...current, lifecycle: "removed" };
          },
        },
        configuration: {
          read: async () => [
            {
              id: "destination",
              label: "Destination",
              value: "supplier",
              required: true,
              options: [{ value: "supplier", label: "Suppliers" }],
            },
          ],
          apply: async () => {
            events.push("configure");
          },
        },
      },
    },
  });
  return { definition, host, events };
}

describe("shared app integration host", () => {
  test("does not disable a binding for another integration", async () => {
    const { host, events } = fixture("xero");
    await expect(
      host.onAction({ kind: "disable", providerId: "quickbooks", accountId: "own-connection" }),
    ).rejects.toMatchObject({ code: "unavailable_action" });
    expect(events).not.toContain("disable:own-binding");
  });
  test("rejects integrations that share an effective connection provider", () => {
    const { definition } = fixture();
    const selected = definition.providers[0]!;
    expect(() =>
      defineAppIntegrations(definition.definition, {
        ...definition,
        providers: [
          selected,
          { ...selected, provider: "xero", connectionProviderKey: "quickbooks" },
        ],
      }),
    ).toThrow("Connection provider is selected twice");
  });
  test("prepares an app-bound grant only after current connection authorization", async () => {
    const { definition: baseDefinition } = fixture();
    const definition = defineAppIntegrations(baseDefinition.definition, {
      ...baseDefinition,
      providers: baseDefinition.providers.map((provider) => ({
        ...provider,
        connectionProviderKey: "books-system",
      })),
    });
    let allowed = false;
    let active = false;
    const issued: unknown[] = [];
    const host = createAppIntegrationHost({
      definition,
      request: async () => new Request("https://app.example"),
      authorize: async () => allowed,
      control: {
        list: async () => ({
          connections: [
            { id: "conn", provider: "books-system", lifecycle: "connected", revision: 1 },
          ],
          bindings: active
            ? [
                {
                  id: "binding",
                  connectionId: "conn",
                  appId: "spend",
                  routingId: "route",
                  appIntegrationKey: "quickbooks",
                  actorId: "test-actor",
                  lifecycle: "active",
                  revision: 1,
                },
              ]
            : [],
        }),
        registerConnection: async () => {
          throw new Error("unexpected");
        },
        requestActivation: async (_request, input) => {
          issued.push(input);
          return { grant: "signed-grant" };
        },
      },
      providers: {
        quickbooks: {
          name: "Books",
          description: "Books",
          ingress: async () => {},
          installations: {
            activate: async () => {
              throw new Error("unexpected");
            },
            activateGrant: async () => {
              throw new Error("unexpected");
            },
            disable: async () => {
              throw new Error("unexpected");
            },
          },
        },
      },
    });
    await expect(host.prepareActivation("quickbooks", "conn")).rejects.toThrow("forbidden");
    expect(issued).toEqual([]);
    allowed = true;
    await expect(host.prepareActivation("quickbooks", "other")).rejects.toThrow("forbidden");
    expect(await host.prepareActivation("quickbooks", "conn")).toEqual({
      status: "ready",
      grant: "signed-grant",
      path: "/spend/api/integrations/quickbooks/activate",
    });
    expect(issued).toEqual([{ connectionId: "conn", appIntegrationKey: "quickbooks" }]);
    active = true;
    expect(await host.prepareActivation("quickbooks", "conn")).toEqual({
      status: "already-active",
    });
    expect(issued).toHaveLength(1);
    await expect(
      host.onAction({ kind: "activate", providerId: "quickbooks", accountId: "conn" }),
    ).rejects.toThrow("unavailable_action");
  });
  test("grant activation reauthenticates and fixes integration and provider from the route", async () => {
    const { host, events } = fixture();
    await expect(
      host.onAction({ kind: "activate", providerId: "quickbooks", accountId: "own-connection" }),
    ).rejects.toThrow("unavailable_action");
    expect(events).toEqual([]);
    await host.activateGrant("quickbooks", "opaque");
    expect(events).toEqual([
      "authenticate",
      "authorize:activate",
      "activate-grant:quickbooks:quickbooks:opaque",
    ]);
    await expect(host.activateGrant("xero", "opaque")).rejects.toThrow("unsupported_provider");
  });
  test("registers only after protected setup readback and fresh connect authorization", async () => {
    const { definition } = fixture();
    const registered: string[] = [];
    let verified = false;
    let allowed = true;
    const host = createAppIntegrationHost({
      definition,
      request: async () => new Request("https://app.example"),
      authorize: async () => allowed,
      control: {
        list: async () => ({ connections: [], bindings: [] }),
        registerConnection: async (_request, input) => {
          registered.push(`${input.externalConnectionId}/${input.externalGroupRef}`);
          return { id: "central-id", provider: "quickbooks", revision: 1, lifecycle: "connected" };
        },
      },
      providers: {
        quickbooks: {
          name: "QuickBooks",
          description: "Suppliers",
          ingress: async () => {},
          connectionSetup: {
            availability: async () => ({ status: "available" }),
            prepare: async () => ({
              setupId: "signed-setup",
              authorizationUrl: "https://provider.example/auth",
            }),
            complete: async () =>
              verified
                ? {
                    status: "verified",
                    externalConnectionId: "verified-provider-id",
                    externalGroupRef: "verified-group",
                  }
                : { status: "pending" },
          },
        },
      },
    });
    expect((await host.loadSurface()).providers[0]?.connect?.availability).toBe("available");
    await host.prepareConnection("quickbooks");
    expect(await host.completeConnection("quickbooks", "signed-setup")).toEqual({
      status: "pending",
    });
    expect(registered).toHaveLength(0);
    verified = true;
    expect(await host.completeConnection("quickbooks", "signed-setup")).toEqual({
      status: "connected",
    });
    expect(registered).toEqual(["verified-provider-id/verified-group"]);
    allowed = false;
    await expect(host.completeConnection("quickbooks", "signed-setup")).rejects.toThrow(
      "forbidden",
    );
    expect(registered).toHaveLength(1);
  });
  test("maps safe central state without disclosing route or revision authority", async () => {
    const { host } = fixture();
    const surface = await host.loadSurface();
    expect(surface.providers[0]?.name).toBe("QuickBooks");
    expect(surface.accounts[0]?.activation.label).toBe("active");
    expect(surface.providers[0]?.connect).toMatchObject({ availability: "unavailable" });
    expect(JSON.stringify(surface)).not.toContain("private-route");
    expect(JSON.stringify(surface)).not.toContain("routingId");
    expect(surface.state?.activity?.status).toBe("error");
  });
  test("reauthenticates and passes only the current binding to shared disable sequencing", async () => {
    const { host, events } = fixture();
    await host.onAction({ kind: "disable", providerId: "quickbooks", accountId: "own-connection" });
    expect(events).toEqual(["authenticate", "authorize:disable", "disable:own-binding"]);
    await expect(
      host.onAction({ kind: "disable", providerId: "quickbooks", accountId: "other-tenant" }),
    ).rejects.toThrow("forbidden");
    expect(events.filter((entry) => entry.startsWith("disable:"))).toHaveLength(1);
  });
  test("does not execute unoffered providers, forbidden actions or invalid configuration choices", async () => {
    const { host, events } = fixture();
    await expect(
      host.onAction({ kind: "configure", providerId: "xero", accountId: "own-connection" }),
    ).rejects.toThrow("unsupported_provider");
    await expect(
      host.onAction({
        kind: "configure",
        providerId: "quickbooks",
        accountId: "own-connection",
        values: { forbidden: "yes" },
      }),
    ).rejects.toThrow("forbidden");
    await expect(
      host.onAction({
        kind: "configure",
        providerId: "quickbooks",
        accountId: "own-connection",
        values: { destination: "arbitrary-model" },
      }),
    ).rejects.toThrow("invalid_action");
    expect(events).not.toContain("configure");
    await host.onAction({
      kind: "configure",
      providerId: "quickbooks",
      accountId: "own-connection",
      values: { destination: "supplier" },
    });
    expect(events.filter((event) => event === "configure")).toHaveLength(1);
  });
  test("keeps provider ingestion independent of human presentation and reports absent configuration", async () => {
    const { host, definition, events } = fixture();
    await host.ingress("quickbooks", Uint8Array.of(42), new Request("https://test.local"));
    expect(events).toEqual(["ingress:42"]);
    const unavailable = createAppIntegrationHost({
      definition,
      providers: {},
      request: async () => new Request("https://test.local"),
      authorize: async () => false,
      control: {
        list: async () => ({ connections: [], bindings: [] }),
        registerConnection: async () => {
          throw Error("unused");
        },
      },
    });
    expect((await unavailable.loadSurface()).providers[0]?.status.label).toBe("Unavailable");
    await expect(
      unavailable.ingress("quickbooks", Uint8Array.of(1), new Request("https://test.local")),
    ).rejects.toThrow("unsupported_provider");
  });
});

test("validated provider selections are isolated from caller mutations", () => {
  const original = fixture().definition;
  const providers = original.providers.map((selection) => ({ ...selection }));
  const validated = defineAppIntegrations(original.definition, { ...original, providers });
  providers[0]!.provider = "xero";
  providers.length = 0;
  expect(validated.providers.map(({ provider }) => provider)).toEqual(["quickbooks"]);
  expect(() => {
    validated.providers[0]!.provider = "ramp";
  }).toThrow();
  expect(validated.providers[0]!.recipe.definition).toBe(original.definition);
});
