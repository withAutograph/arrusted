import { LOOKUP_MODEL_FIELDS, type ModelBlock } from "@domain-libs/_shared";

export const lookup_capacity_blocks: ModelBlock[] = [
  {
    name: "cx_capacity_template",
    kind: "lookup",
    label: "CX Capacity Template",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      // Previously templated.
      segment: { target_model: "segment", label: "Customer Segment" },
      customer_count: { type: "number", label: "Customer Count" },
    },
  },
  {
    name: "quota_capacity_template",
    kind: "lookup",
    label: "Quota Capacity Template",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      segment: { target_model: "segment", label: "Market Segment" },
      default_quota: { type: "money_rate", label: "Default Quota" },
      default_ramp_time_mos: { type: "number", label: "Default Ramp Time (mos)" },
    },
  },
  {
    name: "initiative",
    kind: "lookup",
    label: "Initiative",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
      start_date: { type: "date", label: "Start Date" },
      end_date: { type: "date", label: "End Date" },
      // Previously templated.
      department: { target_model: "department", label: "Department" },
      owner: { target_model: "employee", label: "Owner" },
      budget: { type: "money_rate", label: "Budget" },
      parent_initiative: {
        target_model: "initiative",
        label: "Parent Initiative",
      },
    },
  },
  {
    name: "segment",
    kind: "lookup",
    label: "Segment",
    fields: {
      // Previously essential.
      ...LOOKUP_MODEL_FIELDS,
    },
  },
];
