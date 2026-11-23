import { expect, test } from "vite-plus/test";
import type { DataDefinition } from "../data";

const policyDefinition = {
  formatVersion: 1,
  schemaVersion: "policy-v1",
  models: [],
  capabilities: { authorization: true },
  authorization: {
    version: 1,
    membership: {
      required: true,
      identity: "exact_principal_app_customer_actor_role",
      roles: "current_active_memberships",
    },
    grants: {
      fieldEvaluation: "per_matching_record_predicate",
      recordPredicates: ["all", "actor_equals_field"],
      history: "current_policy_all_or_error_temporal_images",
    },
    supported: [
      "create",
      "get",
      "list",
      "update",
      "delete",
      "count",
      "countBy",
      "history",
      "relation_list",
    ],
    unsupported: [
      "legacy_raw_sql",
      "legacy_prepared_query",
      "legacy_external_key_write_subjects",
      "native_request_endpoints",
      "draft_lifecycle",
      "revert_lifecycle",
      "lookup_lifecycle",
      "lookup_hydration",
      "lookup_reference_count",
      "agent_run_endpoints",
    ],
  },
} as const satisfies DataDefinition;

const rejectedAuthorizationMetadata = {
  formatVersion: 1,
  schemaVersion: "policy-v1",
  models: [],
  authorization: {
    // @ts-expect-error Authorization catalog versions are a generated compatibility contract.
    version: 2,
    membership: {
      required: true,
      identity: "exact_principal_app_customer_actor_role",
      roles: "current_active_memberships",
    },
    grants: {
      fieldEvaluation: "per_matching_record_predicate",
      recordPredicates: ["all"],
      history: "current_policy_all_or_error_temporal_images",
    },
    supported: ["create"],
    // @ts-expect-error Unsupported endpoint names are a closed generated inventory.
    unsupported: ["raw_sql"],
  },
} as const satisfies DataDefinition;

test("policy authorization metadata is accepted as a generated definition contract", () => {
  expect(policyDefinition.authorization.membership.required).toBe(true);
  expect(rejectedAuthorizationMetadata.schemaVersion).toBe("policy-v1");
});
