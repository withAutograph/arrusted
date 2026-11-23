import {
  defineFieldGroups,
  type ImportIdentityPolicy,
  type ImportReconciliationPolicy,
  type ModelBlock,
} from "@domain-libs/_shared";

export const ORG_ASSIGNMENT_FIELD_GROUPS = defineFieldGroups("org_assignment", [
  {
    id: "assignment",
    label: "Assignment",
    fields: ["employee", "position"],
  },
  {
    id: "reporting",
    label: "Reporting",
    fields: ["reports_to_employee", "reports_to_position"],
  },
  {
    id: "timing",
    label: "Timing",
    fields: ["start_date", "end_date"],
  },
] as const);

export const model_org_assignment_blocks: ModelBlock[] = [
  {
    name: "org_assignment",
    kind: "entity",
    label: "Org Assignment",
    field_groups: ORG_ASSIGNMENT_FIELD_GROUPS,
    fields: {
      // Previously essential.
      employee: {
        target_model: "employee",
        label: "Employee",
        notes: "Employee occupying or participating in the assignment.",
      },
      position: {
        target_model: "position",
        label: "Position",
        notes: "Position occupied or planned by the assignment.",
      },
      reports_to_employee: {
        target_model: "employee",
        label: "Manager",
        notes: "Preferred manager target when a human manager is known.",
      },
      reports_to_position: {
        target_model: "position",
        label: "Reports To Position",
        notes: "Fallback manager target for empty-org planning.",
      },
      start_date: {
        type: "date",
        label: "Assignment Start",
      },
      end_date: {
        type: "date",
        label: "Assignment End",
      },
    },
  },
];

export const org_assignment_import_identity_policy = {
  modelId: "org_assignment",
  rungs: [
    { fieldIds: ["employee", "start_date"], kind: "composite" },
    { fieldIds: ["position", "start_date"], kind: "composite" },
  ],
} as const satisfies ImportIdentityPolicy;

export const org_assignment_import_reconciliation_policy = {
  modelId: "org_assignment",
  subjectRelationAlternatives: [["employee"], ["position"]],
  exclusiveRelationGroups: [["reports_to_employee", "reports_to_position"]],
  effectiveStartFieldId: "start_date",
  effectiveEndFieldId: "end_date",
} as const satisfies ImportReconciliationPolicy;
