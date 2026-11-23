import {
  enumFieldFromLookupSeedRows,
  type LookupSeedRow,
  type ModelBlock,
} from "@domain-libs/_shared";

const REQUISITION_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "draft",
    values: {
      name: "Draft",
      sort_order: 1,
      known_aliases: ["Draft", "New"],
    },
  },
  {
    external_key: "approved",
    values: {
      name: "Approved",
      sort_order: 2,
      known_aliases: ["Approved"],
    },
  },
  {
    external_key: "recruiting",
    values: {
      name: "Recruiting",
      sort_order: 3,
      known_aliases: ["Open", "Published", "Active"],
    },
  },
  {
    external_key: "filled",
    values: {
      name: "Filled",
      sort_order: 4,
      known_aliases: ["Filled", "Hired", "Closed - Filled"],
    },
  },
];

const REQUISITION_TYPE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "new_headcount",
    values: {
      name: "New Headcount",
      known_aliases: ["New Position", "Growth"],
    },
  },
  {
    external_key: "backfill",
    values: {
      name: "Backfill",
      known_aliases: ["Replacement", "Attrition"],
    },
  },
  {
    external_key: "conversion",
    values: {
      name: "Conversion",
      known_aliases: ["Contractor to FTE", "Intern Conversion"],
    },
  },
  {
    external_key: "upgrade",
    values: {
      name: "Upgrade",
      known_aliases: ["Level Increase", "Promotion Hire"],
    },
  },
];

const REQUISITION_PRIORITY_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "low",
    values: { name: "Low", sort_order: 1, known_aliases: [] },
  },
  {
    external_key: "medium",
    values: {
      name: "Medium",
      sort_order: 2,
      known_aliases: ["Normal", "Standard"],
    },
  },
  {
    external_key: "high",
    values: {
      name: "High",
      sort_order: 3,
      known_aliases: ["Important"],
    },
  },
  {
    external_key: "critical",
    values: {
      name: "Critical",
      sort_order: 4,
      known_aliases: ["Urgent", "Emergency"],
    },
  },
];

const POSITION_REQUEST_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "requested",
    values: { name: "Requested", known_aliases: [] },
  },
  {
    external_key: "rejected",
    values: { name: "Rejected", known_aliases: [] },
  },
];

/**
 * Requisition Model
 *
 * The requisition is the canonical object for the hiring pipeline. It represents
 * a request to fill a position, and tracks the lifecycle from initial request
 * through to completion.
 *
 * Key concepts:
 * - A requisition can exist before a position (placeholder/request phase)
 * - A requisition can exist before a job_opening (position approved, not yet recruiting)
 * - Status tracks funnel progression; is_on_hold/is_closed are orthogonal modifiers
 *
 * Field ownership strategy:
 * - Requisition captures the *request* (what the manager wants)
 * - Position captures the *reality* (what gets approved/budgeted)
 * - When position is created from requisition, requested values are copied as initial values
 * - Position becomes source of truth for org/budget; requisition retains original request
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * MINIMAL TRUTH FIELDS (AFV effectiveDate provides timestamps)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   position_request_status → enum: requested | rejected (null = not yet requested)
 *   position link         → presence = approved, effectiveDate = approval time
 *   job_opening link       → presence = recruiting, effectiveDate = opening time
 *   job_opening.filled_candidate_name → non-null = filled
 *   is_on_hold              → bool, effectiveDate = hold/resume time (orthogonal modifier)
 *   is_closed              → bool, effectiveDate = close/reopen time (orthogonal modifier)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * STATUS SYNC MECHANISM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The `status` field tracks funnel progression, stored for breakdowns/filtering.
 * is_on_hold and is_closed are orthogonal modifiers that can apply at any funnel stage.
 *
 * Status values: draft | approved | recruiting | filled
 *
 * Status derivation rules (in priority order):
 *   1. job_opening.filled_candidate_name non-null → status = "filled"
 *   2. job_opening link exists                  → status = "recruiting"
 *   3. position link exists                    → status = "approved"
 *   4. otherwise                               → status = "draft"
 *
 * Note: position_request_status (requested/rejected) is NOT reflected in status.
 * It's a separate truth field for tracking position approval workflow with its
 * own AFV effectiveDate. Use it directly for approval funnel analytics.
 *
 * Implementation: A central write hook syncs status whenever truth fields change.
 * This keeps breakdowns trustworthy without requiring callers to remember to sync.
 * The UI can derive status for display; the stored field is for breakdowns.
 */
export const model_requisition_blocks: ModelBlock[] = [
  {
    name: "requisition",
    kind: "entity",
    label: "Requisition",
    // Suggested UI clusters: requisition_summary (id, name, is_sensitive, owner, requestor, is_on_hold, is_closed, target_start_date, department, location, reports_to); linked_entities (position, job_opening); request_details (justification, base_salary, target_bonus, target_commission, job_family, level, manager_role).
    fields: {
      // Previously essential.
      // Identity
      id: {
        type: "text",
        label: "Requisition ID",
        is_unique: true,
        notes: "Unique req identifier. Often like REQ-001 or an ATS tracking number.",
      },
      name: {
        type: "text",
        label: "Requisition Name",
        notes: "Working title for the requisition; may differ from final position name",
      },

      // Status & Classification
      status: enumFieldFromLookupSeedRows(REQUISITION_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      is_sensitive: {
        type: "bool",
        label: "Sensitive",
        notes: "Marks this requisition as sensitive/confidential.",
      },
      type: enumFieldFromLookupSeedRows(REQUISITION_TYPE_SEED_ROWS, {
        label: "Type",
        notes: "New Hire, Backfill, Conversion, Transfer, etc.",
      }),
      priority: enumFieldFromLookupSeedRows(REQUISITION_PRIORITY_SEED_ROWS, {
        label: "Priority",
        notes:
          "Urgency level: Critical, High, Medium, Low, can also be numbers (e.g., 1, 2, 3, 4 or p1, p2 etc.)",
      }),

      // Ownership
      owner: {
        target_model: "employee",
        label: "Owner",
        notes: "The recruiter or agency responsible for filling this requisition",
      },
      requestor: {
        target_model: "employee",
        label: "Requestor",
        notes: "The manager who submitted this requisition",
      },

      // Linked entities (the core relationships)
      position: {
        target_model: "position",
        label: "Position",
        notes:
          "The approved position for this requisition. Presence = approved; AFV effectiveDate = approval time.",
      },
      job_opening: {
        target_model: "job_opening",
        label: "Job Opening",
        notes:
          "The active job opening for recruiting. Presence = recruiting; AFV effectiveDate = opening time.",
      },

      // Lifecycle truth fields (AFV effectiveDate provides timestamps)
      position_request_status: enumFieldFromLookupSeedRows(POSITION_REQUEST_STATUS_SEED_ROWS, {
        label: "Position Request Status",
        notes:
          "Position request state: requested | rejected. Null = not yet requested. AFV effectiveDate = request/reject time.",
      }),
      is_on_hold: {
        type: "bool",
        label: "On Hold",
        notes: "Whether the requisition is paused. AFV effectiveDate = hold/resume time.",
      },
      is_closed: {
        type: "bool",
        label: "Closed",
        notes: "Whether the requisition is closed/archived. AFV effectiveDate = close/reopen time.",
      },

      // Request details (what the manager is asking for)
      target_start_date: {
        type: "date",
        label: "Requested Start Date",
        notes: "Target start date from the requestor; may differ from position.start_date",
      },
      department: {
        target_model: "department",
        label: "Expected Department",
        notes: "Department the role will sit in.",
      },
      location: {
        target_model: "location",
        label: "Expected Location",
        notes: 'Expected work location for the role. Usually an office, "remote", or a city.',
      },
      reports_to: {
        target_model: "employee",
        label: "Hiring Manager",
        notes: "Who the new hire will report to",
      },

      // Notes
      justification: {
        type: "text",
        label: "Business Justification",
        notes: "Free-text business case for why the role is needed.",
      },
      // Previously templated.
      base_salary: {
        type: "money_rate",
        label: "Target Base Salary",
        notes:
          "Budget guidance from requestor; position.base_salary is source of truth once approved",
      },
      target_bonus: {
        type: "money_rate",
        label: "Target Bonus",
        notes: "Requested target bonus amount.",
      },
      target_commission: {
        type: "money_rate",
        label: "Target Commission",
        notes: "Requested target commission. Typically for sales roles.",
      },
      job_family: {
        target_model: "job_family",
        label: "Expected Job Family",
        notes: "Job family the role falls under.",
      },
      level: {
        target_model: "level",
        label: "Expected Compensation Level",
        notes: "Target comp level for the hire.",
      },
      manager_role: {
        type: "bool",
        label: "Manager Role?",
        notes: "Whether this is a people-manager position.",
      },
    },
  },
];
