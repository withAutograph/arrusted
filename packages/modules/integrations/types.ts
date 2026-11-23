/** Presentation only. Hosts load authorized data and reauthorize every action. */
export type IntegrationStatus = {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
  message?: string;
};

export type IntegrationImpact = {
  summary: string;
  affectedApps: readonly string[];
  /** Opaque host review correlation, echoed unchanged; never a credential. */
  reviewToken?: string;
};

/** Public configuration choices only; never credentials, tokens, or trusted scope. */
export type IntegrationConfigurationField = {
  id: string;
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  required?: boolean;
};

export type IntegrationActionKind =
  | "connect"
  | "reconnect"
  | "activate"
  | "configure"
  | "disable"
  | "disconnect";

type ActionAvailability =
  | { availability: "available" }
  | { availability: "unavailable"; reason: string };

export type IntegrationAction = ActionAvailability &
  (
    | { kind: "connect" | "reconnect" | "activate" }
    | { kind: "configure"; fields: readonly IntegrationConfigurationField[] }
    | { kind: "disable" | "disconnect"; impact: IntegrationImpact }
  );

export type IntegrationProvider = {
  id: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  /** Omit when adding another account is not permitted. */
  connect?: IntegrationAction & { kind: "connect" };
};

export type IntegrationAccount = {
  id: string;
  providerId: string;
  label: string;
  status: IntegrationStatus;
  activation: IntegrationStatus;
  health?: IntegrationStatus & { details?: readonly { label: string; value: string }[] };
  actions: readonly (IntegrationAction & { kind: Exclude<IntegrationActionKind, "connect"> })[];
};

export type IntegrationActivity = {
  id: string;
  providerId: string;
  accountLabel?: string;
  title: string;
  detail?: string;
  /** Already formatted by the host for deterministic server/client output. */
  occurredAt: string;
};

export type IntegrationSectionState =
  | { status: "ready" }
  | { status: "loading" }
  | { status: "error"; message: string };

/** Identifiers select presentation rows, never authorize tenant/app/provider access. */
export type IntegrationActionRequest = {
  kind: IntegrationActionKind;
  providerId: string;
  accountId?: string;
  values?: Readonly<Record<string, string>>;
  reviewToken?: string;
};

export type IntegrationActionResult = void | { status: "cancelled" };

export type IntegrationsSurfaceProps = {
  providers: readonly IntegrationProvider[];
  accounts: readonly IntegrationAccount[];
  activity: readonly IntegrationActivity[];
  title?: string;
  description?: string;
  /** Intersection/order only. This cannot create providers or grant actions. */
  providerIds?: readonly string[];
  sections?: { catalog?: boolean; accounts?: boolean; health?: boolean; activity?: boolean };
  state?: {
    catalog?: IntegrationSectionState;
    accounts?: IntegrationSectionState;
    activity?: IntegrationSectionState;
  };
  /** Resolve after completion; reject on failure. Refresh authoritative data in the host. */
  onAction?: (request: IntegrationActionRequest) => Promise<IntegrationActionResult>;
  onRefresh?: () => Promise<void>;
};
