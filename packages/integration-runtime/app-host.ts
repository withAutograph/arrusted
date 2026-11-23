import type {
  IntegrationAppBindingSummary,
  IntegrationBinding,
  IntegrationConnection,
} from "../contracts/integrations";
import type {
  IntegrationAccount,
  IntegrationActionRequest,
  IntegrationActivity,
  IntegrationConfigurationField,
  IntegrationProvider,
  IntegrationsSurfaceProps,
} from "../modules/integrations/types";
import type { AppIntegrationDefinition, IntegrationProviderId } from "./app-definition";
import type { ConnectionSetupAdapter } from "./connection-setup";

type ControlPlane = {
  list(
    request: Request,
  ): Promise<{ connections: IntegrationConnection[]; bindings: IntegrationAppBindingSummary[] }>;
  registerConnection(
    request: Request,
    input: { provider: string; externalConnectionId: string; externalGroupRef: string },
  ): Promise<IntegrationConnection>;
  requestActivation?(
    request: Request,
    input: { connectionId: string; appIntegrationKey: string },
  ): Promise<{ grant: string }>;
};

/** Provider operations are supplied by the platform's configured adapter, never by a browser. */
export type AppIntegrationProviderHost = {
  name: string;
  description: string;
  ingress(rawBody: Uint8Array, request: Request): Promise<unknown>;
  installations?: {
    activate(request: Request, connectionId: string): Promise<IntegrationBinding>;
    activateGrant?(
      request: Request,
      input: {
        grant: string;
        appIntegrationKey: string;
        providerKey: string;
      },
    ): Promise<IntegrationBinding>;
    disable(request: Request, binding: IntegrationBinding): Promise<IntegrationBinding>;
  };
  connectionSetup?: ConnectionSetupAdapter;
  reconnect?(request: Request, connection: IntegrationConnection): Promise<void>;
  configuration?: {
    read(
      request: Request,
      connection: IntegrationConnection,
      binding?: IntegrationBinding,
    ): Promise<readonly IntegrationConfigurationField[]>;
    apply(
      request: Request,
      connection: IntegrationConnection,
      values: Readonly<Record<string, string>>,
      binding?: IntegrationBinding,
    ): Promise<void>;
  };
};

export class AppIntegrationHostError extends Error {
  readonly status = 403;
  constructor(
    public readonly code:
      | "unsupported_provider"
      | "unavailable_action"
      | "invalid_action"
      | "forbidden",
  ) {
    super(code);
  }
}

/** Shared app DAL composition: human reads/actions and signed provider ingress stay separate. */
export function createAppIntegrationHost(input: {
  definition: AppIntegrationDefinition;
  /** Derive a fresh authenticated server request on every human invocation. */
  request(): Promise<Request>;
  control: ControlPlane;
  providers: Partial<Record<IntegrationProviderId, AppIntegrationProviderHost>>;
  /** Server authorization drives action availability and is checked again on submit. */
  authorize(
    request: Request,
    action: IntegrationActionRequest,
    connection?: IntegrationConnection,
  ): Promise<boolean>;
  activity?(request: Request): Promise<readonly IntegrationActivity[]>;
}) {
  if (typeof window !== "undefined") throw new Error("Integration host is server-only");
  const selected = new Set(input.definition.providers.map(({ provider }) => provider));
  const connectionProvider = (provider: string) =>
    input.definition.providers.find((selection) => selection.provider === provider)
      ?.connectionProviderKey ?? provider;
  const configured = (provider: string) => {
    if (!selected.has(provider as IntegrationProviderId))
      throw new AppIntegrationHostError("unsupported_provider");
    return input.providers[provider as IntegrationProviderId];
  };
  const authorize = async (
    request: Request,
    action: IntegrationActionRequest,
    connection?: IntegrationConnection,
  ) => {
    if (!(await input.authorize(request, action, connection)))
      throw new AppIntegrationHostError("forbidden");
  };

  return {
    async prepareActivation(providerId: string, accountId: string) {
      const adapter = configured(providerId);
      if (!adapter?.installations?.activateGrant || !input.control.requestActivation)
        throw new AppIntegrationHostError("unavailable_action");
      const request = await input.request();
      const current = await input.control.list(request);
      const connection = current.connections.find(
        (item) =>
          item.id === accountId &&
          item.provider === connectionProvider(providerId) &&
          item.lifecycle === "connected",
      );
      if (!connection) throw new AppIntegrationHostError("forbidden");
      await authorize(request, { kind: "activate", providerId, accountId }, connection);
      if (
        current.bindings.some(
          (binding) =>
            binding.connectionId === connection.id &&
            binding.appId === input.definition.appId &&
            binding.appIntegrationKey === providerId &&
            binding.lifecycle === "active",
        )
      )
        return { status: "already-active" as const };
      const { grant } = await input.control.requestActivation(request, {
        connectionId: connection.id,
        appIntegrationKey: providerId,
      });
      return {
        status: "ready" as const,
        grant,
        path: `/${input.definition.appId}/api/integrations/${providerId}/activate`,
      };
    },
    async activateGrant(providerId: IntegrationProviderId, grant: string): Promise<void> {
      const adapter = configured(providerId);
      if (
        !adapter?.installations?.activateGrant ||
        typeof grant !== "string" ||
        grant.length > 2048
      )
        throw new AppIntegrationHostError("unavailable_action");
      const request = await input.request();
      await authorize(request, { kind: "activate", providerId });
      await adapter.installations.activateGrant(request, {
        grant,
        appIntegrationKey: providerId,
        providerKey: connectionProvider(providerId),
      });
    },
    async ingress(
      provider: IntegrationProviderId,
      rawBody: Uint8Array,
      request: Request,
    ): Promise<unknown> {
      const adapter = configured(provider);
      if (!adapter) throw new AppIntegrationHostError("unsupported_provider");
      // The adapter is built with createIntegrationIngress, signature verification,
      // installation identity readback, central binding lease and generated DAL context.
      return adapter.ingress(rawBody, request);
    },
    async loadSurface(): Promise<
      Pick<IntegrationsSurfaceProps, "providers" | "accounts" | "activity" | "state">
    > {
      const request = await input.request();
      const { connections, bindings } = await input.control.list(request);
      const providers: IntegrationProvider[] = [];
      const accounts: IntegrationAccount[] = [];
      for (const providerId of selected) {
        const adapter = configured(providerId);
        const connectionAvailability =
          adapter?.connectionSetup !== undefined &&
          (await input.authorize(request, { kind: "connect", providerId }))
            ? await adapter.connectionSetup.availability(request)
            : undefined;
        const canConnect = connectionAvailability?.status === "available";
        providers.push({
          id: providerId,
          name: adapter?.name ?? providerId,
          description:
            adapter?.description ?? "The provider adapter is not configured for this app.",
          status: {
            label: adapter ? "Available" : "Unavailable",
            tone: adapter ? "neutral" : "warning",
          },
          connect: canConnect
            ? { kind: "connect", availability: "available" }
            : {
                kind: "connect",
                availability: "unavailable",
                reason:
                  connectionAvailability?.status === "unavailable"
                    ? connectionAvailability.reason
                    : adapter?.connectionSetup
                      ? "Connection management is not permitted."
                      : "A protected provider connection flow is not configured.",
              },
        });
        for (const connection of connections.filter(
          (item) => item.provider === connectionProvider(providerId),
        )) {
          const binding = bindings.find(
            (item) =>
              item.connectionId === connection.id &&
              item.appId === input.definition.appId &&
              item.lifecycle !== "removed",
          );
          const actions: IntegrationAccount["actions"][number][] = [];
          const offer = async (action: IntegrationAccount["actions"][number]) => {
            if (
              await input.authorize(
                request,
                { kind: action.kind, providerId, accountId: connection.id },
                connection,
              )
            )
              actions.push(action);
          };
          if (adapter?.installations && connection.lifecycle === "connected") {
            if (
              (!binding || binding.lifecycle === "pending") &&
              adapter.installations.activateGrant &&
              input.control.requestActivation
            )
              await offer({ kind: "activate", availability: "available" });
            if (binding?.lifecycle === "active" || binding?.lifecycle === "suspending")
              await offer({
                kind: "disable",
                availability: "available",
                impact: {
                  summary:
                    "Stop this app from receiving new provider data. Existing canonical records remain.",
                  affectedApps: [input.definition.appId],
                },
              });
          }
          if (adapter?.reconnect) await offer({ kind: "reconnect", availability: "available" });
          if (
            adapter?.configuration &&
            (await input.authorize(
              request,
              { kind: "configure", providerId, accountId: connection.id },
              connection,
            ))
          )
            actions.push({
              kind: "configure",
              availability: "available",
              fields: await adapter.configuration.read(request, connection, binding),
            });
          accounts.push({
            id: connection.id,
            providerId,
            label: `${adapter?.name ?? providerId} account`,
            status: {
              label: connection.lifecycle,
              tone: connection.lifecycle === "connected" ? "success" : "warning",
            },
            activation: {
              label: binding?.lifecycle ?? "Not active for this app",
              tone: binding?.lifecycle === "active" ? "success" : "neutral",
            },
            health: { label: "Not reported", tone: "neutral" },
            actions,
          });
        }
      }
      return {
        providers,
        accounts,
        activity: input.activity ? await input.activity(request) : [],
        state: {
          catalog: { status: "ready" },
          accounts: { status: "ready" },
          activity: input.activity
            ? { status: "ready" }
            : {
                status: "error",
                message: "Integration activity is not available from the configured provider host.",
              },
        },
      };
    },
    async prepareConnection(providerId: string) {
      const adapter = configured(providerId);
      if (!adapter?.connectionSetup) throw new AppIntegrationHostError("unavailable_action");
      const request = await input.request();
      await authorize(request, { kind: "connect", providerId });
      return adapter.connectionSetup.prepare(request);
    },
    async completeConnection(providerId: string, setupId: string) {
      const adapter = configured(providerId);
      if (!adapter?.connectionSetup) throw new AppIntegrationHostError("unavailable_action");
      const request = await input.request();
      await authorize(request, { kind: "connect", providerId });
      const result = await adapter.connectionSetup.complete(request, setupId);
      if (result.status === "pending") return { status: "pending" as const };
      // The provider callback/URL is never connection authority. Central registration
      // independently verifies exact provider/tenant connection ownership again.
      await input.control.registerConnection(request, {
        provider: connectionProvider(providerId),
        externalConnectionId: result.externalConnectionId,
        externalGroupRef: result.externalGroupRef,
      });
      return { status: "connected" as const };
    },
    async onAction(action: IntegrationActionRequest): Promise<void> {
      if (
        !action ||
        !["connect", "reconnect", "activate", "configure", "disable", "disconnect"].includes(
          action.kind,
        )
      )
        throw new AppIntegrationHostError("invalid_action");
      // Activation is admitted only through the opaque-grant POST route.
      if (action.kind === "activate") throw new AppIntegrationHostError("unavailable_action");
      const adapter = configured(action.providerId);
      if (!adapter) throw new AppIntegrationHostError("unavailable_action");
      if (action.kind === "connect") {
        // The shared client bridge owns opening the protected OAuth URL and asking
        // for completion; a server action cannot perform the browser interaction.
        throw new AppIntegrationHostError("unavailable_action");
      }
      const request = await input.request();
      // list authenticates the current app/tenant; browser row identifiers are only selectors.
      const current = await input.control.list(request);
      const connection = current.connections.find(
        (item) =>
          item.id === action.accountId && item.provider === connectionProvider(action.providerId),
      );
      if (!connection) throw new AppIntegrationHostError("forbidden");
      await authorize(request, action, connection);
      const binding = current.bindings.find(
        (item) =>
          item.connectionId === connection.id &&
          item.appId === input.definition.appId &&
          item.appIntegrationKey === action.providerId &&
          item.lifecycle !== "removed",
      );
      if (action.kind === "disable" && adapter.installations && binding) {
        await adapter.installations.disable(request, binding);
      } else if (action.kind === "reconnect" && adapter.reconnect) {
        await adapter.reconnect(request, connection);
      } else if (action.kind === "configure" && adapter.configuration) {
        const fields = await adapter.configuration.read(request, connection, binding);
        const values = action.values;
        if (
          !values ||
          Object.keys(values).some((key) => !fields.some((field) => field.id === key)) ||
          fields.some(
            (field) =>
              (field.required && !values[field.id]) ||
              (values[field.id] !== undefined &&
                !field.options.some((option) => option.value === values[field.id])),
          )
        ) {
          throw new AppIntegrationHostError("invalid_action");
        }
        await adapter.configuration.apply(request, connection, values, binding);
      } else {
        // Organization-wide disconnect requires its separate reviewed impact workflow.
        throw new AppIntegrationHostError("unavailable_action");
      }
    },
  };
}
