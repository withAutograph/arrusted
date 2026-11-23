import type {
  AppId,
  AppliedChangeSet,
  CustomerId,
  ModelId,
  RecordKey,
  VisibleRecord,
} from "./wire.generated";

export type * from "./wire.generated";
export type * from "./integrations";

export type TenantScope = {
  // TS convenience shape; KernelClient implementations translate to snake_case wire keys.
  appId: AppId;
  customerId: CustomerId;
};

export type KernelClient = {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body: unknown, init?: { signal?: AbortSignal }): Promise<T>;
};

export type RecordsByModelResponse = {
  records_by_model: Partial<Record<ModelId, VisibleRecord[]>>;
};

// One record a link may choose (`POST /api/record-options`): the raw parts
// of its label. Clients name it by `name`, else `external_key`, else
// generically; never by its record id.
export type RecordOption = {
  record_key: Extract<RecordKey, { type: "record_id" }>;
  name: string | null;
  external_key: string | null;
};

// The best matches; `truncated` when more records match than were returned.
export type RecordOptionsResponse = {
  options: RecordOption[];
  truncated: boolean;
};

export type ApplyDryRunResponse = {
  ok: true;
  dry_run: true;
  change_set: AppliedChangeSet;
};

export type AtomicApplyDryRunResponse = {
  ok: true;
  dry_run: true;
  change_sets: AppliedChangeSet[];
};

export type TrustedIntegrationApplyResponse = {
  ok: true;
  replayed: boolean;
  change_set: AppliedChangeSet;
};

export type AppRuntime = {
  appId: AppId;
  auth?: {
    actor: {
      actorId: string;
      email: string | null;
      name: string | null;
    };
    customerId: CustomerId;
    organizationSlug: string;
  };
  basePath: string;
  apiBasePath: string;
  initialPath: string;
  navigate(path: string): void;
};

export type AppRuntimeSeed = Omit<AppRuntime, "navigate">;

// Agent streaming transport — the versioned SSE event contract (v1) shared by
// the backend emitter and the frontend consumer.
//
// Type-only + additive-only: new event types / optional fields extend this;
// existing ones never change shape. Generic over the TERMINAL payload so this
// stays app-agnostic — the terminal event carries exactly the app's own run
// response (for HC: `HcAgentRunWireResponse`), which the app supplies as
// `TTerminal`; contracts must not know app-domain response schemas.
// `out_of_budget` is a dormant v1 compatibility value. Current runtimes do not
// emit it, but additive-only wire readers retain it for rolling deployments.
export type AgentPhase = "searching" | "drafting" | "checking" | "repairing" | "out_of_budget";

export type AgentStreamWireEvent<TTerminal> =
  | {
      v: 1;
      type: "phase";
      phase: AgentPhase;
      /** Repair attempt ordinal (repairing phase). */
      attempt?: number;
      /**
       * How many issues the repair pass is fixing (repairing phase). Optional +
       * additive: when present the label reads "Fixing N issues — attempt K";
       * when absent it degrades to "Fixing issues — attempt K".
       */
      issueCount?: number;
    }
  | { v: 1; type: "tool_start"; callId: string; title: string }
  | { v: 1; type: "tool_end"; callId: string; status: "done" | "error"; outcome?: string }
  | { v: 1; type: "text_delta"; delta: string }
  | { v: 1; type: "terminal"; response: TTerminal }
  | { v: 1; type: "stream_error"; message: string };
