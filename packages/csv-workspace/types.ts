import type {
  AppId,
  AppliedChangeSet,
  ChangeSetDiff,
  CustomerId,
  RecentActivityEntry,
  Schema,
  SchemaRevisionId,
  VisibleRecord,
} from "../contracts/index";
import type { ImportIdentityPolicy } from "../engines/import-classification/index";
import type { WorkspaceDraft } from "./draft";

export type CsvWorkspaceRecoveryContext = {
  appId: AppId;
  customerId: CustomerId;
  actorId: string;
  asOf: string;
};
export type CsvWorkspaceContext = {
  schema: Schema;
  schemaRevisionId: SchemaRevisionId;
  scope: { appId: AppId; customerId: CustomerId };
  actorId: string;
  asOf: string;
  recoveryContext: CsvWorkspaceRecoveryContext;
  policies: readonly ImportIdentityPolicy[];
  recordsByModel: Record<string, VisibleRecord[]>;
  activity: RecentActivityEntry[];
};
export type CsvWorkspaceTurnInput = {
  schemaRevisionId: SchemaRevisionId;
  csv: string;
  draft: WorkspaceDraft;
  instruction: string;
  conversation?: readonly { role: "user" | "assistant"; content: string }[];
};
export type CsvWorkspaceSaveInput = {
  draft: WorkspaceDraft;
  schemaRevisionId: SchemaRevisionId;
  sourceFilename: string;
  idempotencyKey: string;
  recoveryContext: CsvWorkspaceRecoveryContext;
};
export type CsvWorkspaceSaveResult = {
  applied: AppliedChangeSet;
  recordsByModel: Record<string, VisibleRecord[]>;
  activity: RecentActivityEntry[];
  diff: ChangeSetDiff;
  recoveryContext: CsvWorkspaceRecoveryContext;
};
