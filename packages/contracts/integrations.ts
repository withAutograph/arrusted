/** Public control-plane DTOs. Provider payloads and credentials never cross this API. */
export type IntegrationConnection = {
  id: string;
  provider: string;
  lifecycle: "pending" | "connected" | "disconnecting" | "disconnected" | "failed";
  revision: number;
};
/** Safe tenant registry projection. External provider identifiers remain server-only. */
export type IntegrationConnectionSummary = IntegrationConnection & {
  displayLabel: string | null;
  actorId: string | null;
};
export type IntegrationBinding = {
  id: string;
  connectionId: string;
  appId: string;
  routingId: string;
  lifecycle: "pending" | "active" | "suspending" | "removed";
  revision: number;
};
/** Safe app registry projection. The external installation id remains server-only. */
export type IntegrationAppBindingSummary = IntegrationBinding & {
  appIntegrationKey: string | null;
  actorId: string | null;
};
export type IntegrationDisconnectImpact = {
  connectionId: string;
  revision: number;
  bindings: readonly { id: string; appId: string; revision: number }[];
};
export type IntegrationDeliveryIdentity = {
  customerId: string;
  appId: string;
  bindingId: string;
  connectionId: string;
  routingId: string;
};
export type ActiveIntegrationAuthority = IntegrationDeliveryIdentity & {
  bindingRevision: number;
  lifecycle: "active";
  actorId: string;
};

/** Signed, short-lived activation-only wire claim. Never a provider payload. */
export type IntegrationActivationGrant = {
  version: 1;
  aud: "integration-activation";
  actor_id: string;
  customer_id: string;
  app_id: string;
  app_integration_key: string;
  provider_key: string;
  connection_id: string;
  binding_id: string;
  binding_revision: number;
  iat: number;
  exp: number;
  nonce: string;
};

export type ActivationGrantScope = Pick<
  IntegrationActivationGrant,
  "actor_id" | "customer_id" | "app_id" | "app_integration_key" | "provider_key" | "connection_id"
>;
