import {
  enumFieldFromLookupSeedRows,
  type FieldDefinition,
  type LookupSeedRow,
  type ModelBlock,
} from "@domain-libs/_shared";

function managedField<T extends FieldDefinition>(field: T): T {
  return field;
}

const JOB_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "open",
    values: { name: "Open", known_aliases: ["active"] },
  },
  {
    external_key: "archived",
    values: { name: "Archived", known_aliases: ["closed"] },
  },
];

const OPENING_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "open",
    values: { name: "Open", known_aliases: ["active"] },
  },
  {
    external_key: "closed",
    values: {
      name: "Closed",
      known_aliases: ["filled", "closed"],
    },
  },
  {
    external_key: "draft",
    values: { name: "Draft", known_aliases: ["draft"] },
  },
  {
    external_key: "archived",
    values: {
      name: "Archived",
      known_aliases: ["archived"],
    },
  },
  {
    external_key: "pending",
    values: { name: "Pending", known_aliases: ["pending"] },
  },
];

const CANDIDATE_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "prospect",
    values: {
      name: "Prospect",
      known_aliases: ["prospect"],
    },
  },
  {
    external_key: "active",
    values: { name: "Active", known_aliases: ["active"] },
  },
  {
    external_key: "hired",
    values: { name: "Hired", known_aliases: ["hired"] },
  },
  {
    external_key: "rejected",
    values: {
      name: "Rejected",
      known_aliases: ["rejected"],
    },
  },
  {
    external_key: "withdrawn",
    values: {
      name: "Withdrawn",
      known_aliases: ["withdrawn"],
    },
  },
];

const CANDIDATE_SOURCE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "inbound",
    values: { name: "Inbound", known_aliases: ["inbound"] },
  },
  {
    external_key: "referral",
    values: {
      name: "Referral",
      known_aliases: ["referral"],
    },
  },
  {
    external_key: "outbound",
    values: {
      name: "Outbound",
      known_aliases: ["outbound"],
    },
  },
  {
    external_key: "agency",
    values: { name: "Agency", known_aliases: ["agency"] },
  },
  {
    external_key: "job_board",
    values: {
      name: "Job Board",
      known_aliases: ["job_board", "job-board"],
    },
  },
  {
    external_key: "campus",
    values: { name: "Campus", known_aliases: ["campus"] },
  },
];

const APPLICATION_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "active",
    values: { name: "Active", known_aliases: ["active"] },
  },
  {
    external_key: "rejected",
    values: {
      name: "Rejected",
      known_aliases: ["rejected"],
    },
  },
  {
    external_key: "hired",
    values: { name: "Hired", known_aliases: ["hired"] },
  },
  {
    external_key: "withdrawn",
    values: {
      name: "Withdrawn",
      known_aliases: ["withdrawn"],
    },
  },
];

const APPLICATION_STAGE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "applied",
    values: { name: "Applied", known_aliases: ["applied"] },
  },
  {
    external_key: "screen",
    values: {
      name: "Screen",
      known_aliases: ["screen", "screening"],
    },
  },
  {
    external_key: "interview",
    values: {
      name: "Interview",
      known_aliases: ["interview"],
    },
  },
  {
    external_key: "decision",
    values: {
      name: "Decision",
      known_aliases: ["decision"],
    },
  },
  {
    external_key: "offer",
    values: { name: "Offer", known_aliases: ["offer"] },
  },
  {
    external_key: "hired",
    values: { name: "Hired", known_aliases: ["hired"] },
  },
  {
    external_key: "rejected",
    values: {
      name: "Rejected",
      known_aliases: ["rejected"],
    },
  },
];

const APPLICATION_SOURCE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "inbound",
    values: { name: "Inbound", known_aliases: ["inbound"] },
  },
  {
    external_key: "referral",
    values: {
      name: "Referral",
      known_aliases: ["referral"],
    },
  },
  {
    external_key: "outbound",
    values: {
      name: "Outbound",
      known_aliases: ["outbound"],
    },
  },
  {
    external_key: "agency",
    values: { name: "Agency", known_aliases: ["agency"] },
  },
  {
    external_key: "job_board",
    values: {
      name: "Job Board",
      known_aliases: ["job_board", "job-board"],
    },
  },
  {
    external_key: "campus",
    values: { name: "Campus", known_aliases: ["campus"] },
  },
];

const APPLICATION_REJECTION_REASON_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "experience",
    values: {
      name: "Experience Mismatch",
      known_aliases: ["experience", "experience_mismatch"],
    },
  },
  {
    external_key: "compensation",
    values: {
      name: "Compensation",
      known_aliases: ["compensation", "salary"],
    },
  },
  {
    external_key: "location",
    values: {
      name: "Location",
      known_aliases: ["location"],
    },
  },
  {
    external_key: "culture",
    values: {
      name: "Culture Fit",
      known_aliases: ["culture", "culture_fit"],
    },
  },
  {
    external_key: "other",
    values: { name: "Other", known_aliases: ["other"] },
  },
];

const INTERVIEW_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "scheduled",
    values: {
      name: "Scheduled",
      known_aliases: ["scheduled"],
    },
  },
  {
    external_key: "completed",
    values: {
      name: "Completed",
      known_aliases: ["completed"],
    },
  },
  {
    external_key: "cancelled",
    values: {
      name: "Cancelled",
      known_aliases: ["cancelled"],
    },
  },
  {
    external_key: "no_show",
    values: { name: "No Show", known_aliases: ["no_show"] },
  },
];

const INTERVIEW_STAGE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "screen",
    values: {
      name: "Screen",
      known_aliases: ["screen", "screening"],
    },
  },
  {
    external_key: "technical",
    values: {
      name: "Technical",
      known_aliases: ["technical"],
    },
  },
  {
    external_key: "onsite",
    values: { name: "Onsite", known_aliases: ["onsite"] },
  },
  {
    external_key: "final",
    values: { name: "Final", known_aliases: ["final"] },
  },
];

const INTERVIEW_TYPE_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "phone",
    values: { name: "Phone", known_aliases: ["phone"] },
  },
  {
    external_key: "video",
    values: { name: "Video", known_aliases: ["video"] },
  },
  {
    external_key: "onsite",
    values: { name: "Onsite", known_aliases: ["onsite"] },
  },
  {
    external_key: "take_home",
    values: {
      name: "Take Home",
      known_aliases: ["take_home"],
    },
  },
];

const OFFER_STATUS_SEED_ROWS: readonly LookupSeedRow[] = [
  {
    external_key: "draft",
    values: { name: "Draft", known_aliases: ["draft"] },
  },
  {
    external_key: "sent",
    values: { name: "Sent", known_aliases: ["sent"] },
  },
  {
    external_key: "accepted",
    values: {
      name: "Accepted",
      known_aliases: ["accepted"],
    },
  },
  {
    external_key: "declined",
    values: {
      name: "Declined",
      known_aliases: ["declined"],
    },
  },
  {
    external_key: "expired",
    values: { name: "Expired", known_aliases: ["expired"] },
  },
];

export const model_recruiting_blocks: ModelBlock[] = [
  {
    name: "job",
    kind: "entity",
    label: "Job",
    // Suggested UI clusters: job_summary (id, name, description, code, title, department, job_opening, external_id, location, reports_to, type).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "ID",
        is_unique: true,
      },
      name: { type: "text", label: "Job Name" },
      description: {
        type: "text",
        label: "Description",
      },
      code: { type: "text", label: "Code" },
      status: enumFieldFromLookupSeedRows(JOB_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      title: { type: "text", label: "Title" },
      department: {
        target_model: "department",
        label: "Department",
      },
      job_opening: {
        target_model: "job_opening",
        label: "Openings",
        is_multi_value: true,
      },
      external_id: {
        type: "text",
        label: "External ID",
      },
      location: {
        target_model: "location",
        label: "Work Location",
      },
      reports_to: {
        target_model: "employee",
        label: "Hiring Manager",
      },
      // Previously templated.
      type: { type: "text", label: "Type" },
    },
  },
  {
    name: "job_opening",
    kind: "entity",
    label: "Job Opening",
    // Suggested UI clusters: job_opening_summary (id, name, title, job, start_date, target_start_date, filled_candidate_name, end_date); job_opening_details (content).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Reference ID",
        is_unique: true,
        notes: "Unique job opening identifier.",
      },
      name: {
        type: "text",
        label: "Opening Reference (Human-readable)",
        notes: "Human-readable reference for the opening.",
      },
      title: {
        type: "text",
        label: "Title",
        notes: "Job posting title as shown to candidates.",
      },
      job: {
        target_model: "job",
        label: "Job",
        notes: "The job template this opening is for.",
      },
      status: enumFieldFromLookupSeedRows(OPENING_STATUS_SEED_ROWS, {
        label: "Opening Status",
        notes: "Open, Closed, Filled, Cancelled, etc.",
      }),
      start_date: {
        type: "date",
        label: "Date Opened",
        notes: "When the opening was created/published.",
      },
      target_start_date: {
        type: "date",
        label: "Target Start Date",
        notes: "Target start date for the hire.",
      },
      filled_candidate_name: {
        type: "text",
        label: "Candidate Name",
        notes: "Name of the hired candidate once filled.",
      },
      end_date: {
        type: "date",
        label: "Close Date",
        notes: "When the opening was closed.",
      },
      // Previously templated.
      content: {
        type: "text",
        label: "Content",
        notes: "Job posting body/description text.",
      },
    },
  },
  {
    name: "candidate",
    kind: "entity",
    label: "Candidate",
    // Suggested UI clusters: candidate_summary (id, name, primary_email, company, title, applications, name_first, name_last, name_display, photo_url, is_private, can_email, recruiter, coordinator); candidate_details (email_addresses, phone_numbers, addresses, website_addresses, social_media_addresses, locations, urls, tags, attachments, linked_user_ids, custom_fields, keyed_custom_fields).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Candidate ID",
        is_unique: true,
      },
      name: { type: "text", label: "Full Name" },
      status: enumFieldFromLookupSeedRows(CANDIDATE_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      source: enumFieldFromLookupSeedRows(CANDIDATE_SOURCE_SEED_ROWS, {
        label: "Source",
      }),
      primary_email: {
        type: "text",
        label: "Primary Email",
      },
      company: { type: "text", label: "Company" },
      title: { type: "text", label: "Title" },
      applications: {
        target_model: "application",
        label: "Applications",
        is_multi_value: true,
      },
      external_id: managedField({
        type: "text",
        label: "External ID",
      }),
      // Previously templated.
      name_first: {
        type: "text",
        label: "First Name",
      },
      name_last: {
        type: "text",
        label: "Last Name",
      },
      name_display: {
        type: "text",
        label: "Preferred Name",
      },
      email_addresses: {
        type: "json",
        label: "Email Addresses",
      },
      phone_numbers: {
        type: "json",
        label: "Phone Numbers",
      },
      addresses: {
        type: "json",
        label: "Addresses",
      },
      website_addresses: {
        type: "json",
        label: "Website Addresses",
      },
      social_media_addresses: {
        type: "json",
        label: "Social Media Addresses",
      },
      locations: {
        type: "json",
        label: "Locations",
      },
      urls: { type: "json", label: "URLs" },
      tags: { type: "text_list", label: "Tags" },
      photo_url: {
        type: "text",
        label: "Photo URL",
      },
      is_private: {
        type: "bool",
        label: "Private",
      },
      can_email: {
        type: "bool",
        label: "Can Email",
      },
      created_at: managedField({
        type: "datetime",
        label: "Created At",
      }),
      updated_at: managedField({
        type: "datetime",
        label: "Updated At",
      }),
      last_activity_at: managedField({
        type: "datetime",
        label: "Last Activity At",
      }),
      last_interaction_at: managedField({
        type: "datetime",
        label: "Last Interaction At",
      }),
      recruiter: {
        type: "json",
        label: "Recruiter",
      },
      coordinator: {
        type: "json",
        label: "Coordinator",
      },
      attachments: {
        type: "json",
        label: "Attachments",
      },
      linked_user_ids: {
        type: "text_list",
        label: "Linked User IDs",
      },
      custom_fields: {
        type: "json",
        label: "Custom Fields",
      },
      keyed_custom_fields: {
        type: "json",
        label: "Keyed Custom Fields",
      },
      remote_id: managedField({
        type: "text",
        label: "Remote ID",
      }),
      remote_template_id: managedField({
        type: "text",
        label: "Remote Template ID",
      }),
      remote_created_at: managedField({
        type: "datetime",
        label: "Remote Created At",
      }),
      remote_updated_at: managedField({
        type: "datetime",
        label: "Remote Updated At",
      }),
      remote_was_deleted: managedField({
        type: "bool",
        label: "Remote Was Deleted",
      }),
      field_mappings: managedField({
        type: "json",
        label: "Field Mappings",
      }),
      remote_data: managedField({
        type: "json",
        label: "Remote Data",
      }),
      integration_params: managedField({
        type: "json",
        label: "Integration Params",
      }),
      linked_account_params: managedField({
        type: "json",
        label: "Linked Account Params",
      }),
    },
  },
  {
    name: "application",
    kind: "entity",
    label: "Application",
    // Suggested UI clusters: application_summary (id, candidate, requisition, job_opening, job, assigned_recruiter, is_prospect); application_details (source_raw, credited_to, recruiter, coordinator, referrer, location, job_post_id, jobs, rejection_details, screening_question_answers, answers, attachments, offers, custom_fields, keyed_custom_fields, prospect_detail, prospective_department, prospective_office).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Application ID",
        is_unique: true,
      },
      candidate: {
        target_model: "candidate",
        label: "Candidate",
      },
      requisition: {
        target_model: "requisition",
        label: "Requisition",
      },
      job_opening: {
        target_model: "job_opening",
        label: "Job Opening",
      },
      job: {
        target_model: "job",
        label: "Job",
      },
      status: enumFieldFromLookupSeedRows(APPLICATION_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      current_stage: enumFieldFromLookupSeedRows(APPLICATION_STAGE_SEED_ROWS, {
        label: "Current Stage",
      }),
      created_at: managedField({
        type: "datetime",
        label: "Created At",
      }),
      updated_at: managedField({
        type: "datetime",
        label: "Updated At",
      }),
      applied_at: managedField({
        type: "datetime",
        label: "Applied At",
      }),
      rejected_at: managedField({
        type: "datetime",
        label: "Rejected At",
      }),
      last_activity_at: managedField({
        type: "datetime",
        label: "Last Activity At",
      }),
      stage_entered_at: managedField({
        type: "datetime",
        label: "Stage Entered At",
        notes:
          "Prefer ATS timestamps when available; otherwise derive from Timeline on current_stage.",
      }),
      source: enumFieldFromLookupSeedRows(APPLICATION_SOURCE_SEED_ROWS, {
        label: "Source",
      }),
      assigned_recruiter: {
        target_model: "employee",
        label: "Assigned Recruiter",
      },
      is_prospect: {
        type: "bool",
        label: "Prospect",
      },
      rejection_reason: enumFieldFromLookupSeedRows(APPLICATION_REJECTION_REASON_SEED_ROWS, {
        label: "Rejection Reason",
      }),
      external_id: managedField({
        type: "text",
        label: "External ID",
      }),
      // Previously templated.
      source_raw: {
        type: "json",
        label: "Source (Raw)",
      },
      credited_to: {
        type: "json",
        label: "Credited To",
      },
      recruiter: {
        type: "json",
        label: "Recruiter",
      },
      coordinator: {
        type: "json",
        label: "Coordinator",
      },
      referrer: {
        type: "json",
        label: "Referrer",
      },
      location: {
        type: "json",
        label: "Location",
      },
      job_post_id: {
        type: "text",
        label: "Job Post ID",
      },
      jobs: { type: "json", label: "Jobs" },
      rejection_details: {
        type: "json",
        label: "Rejection Details",
      },
      screening_question_answers: {
        type: "json",
        label: "Screening Question Answers",
      },
      answers: {
        type: "json",
        label: "Answers",
      },
      attachments: {
        type: "json",
        label: "Attachments",
      },
      offers: { type: "json", label: "Offers" },
      custom_fields: {
        type: "json",
        label: "Custom Fields",
      },
      keyed_custom_fields: {
        type: "json",
        label: "Keyed Custom Fields",
      },
      prospect_detail: {
        type: "json",
        label: "Prospect Detail",
      },
      prospective_department: {
        type: "json",
        label: "Prospective Department",
      },
      prospective_office: {
        type: "json",
        label: "Prospective Office",
      },
      remote_id: managedField({
        type: "text",
        label: "Remote ID",
      }),
      remote_template_id: managedField({
        type: "text",
        label: "Remote Template ID",
      }),
      remote_user_id: managedField({
        type: "text",
        label: "Remote User ID",
      }),
      remote_created_at: managedField({
        type: "datetime",
        label: "Remote Created At",
      }),
      remote_updated_at: managedField({
        type: "datetime",
        label: "Remote Updated At",
      }),
      remote_was_deleted: managedField({
        type: "bool",
        label: "Remote Was Deleted",
      }),
      field_mappings: managedField({
        type: "json",
        label: "Field Mappings",
      }),
      remote_data: managedField({
        type: "json",
        label: "Remote Data",
      }),
      integration_params: managedField({
        type: "json",
        label: "Integration Params",
      }),
      linked_account_params: managedField({
        type: "json",
        label: "Linked Account Params",
      }),
    },
  },
  {
    name: "interview",
    kind: "entity",
    label: "Interview",
    // Suggested UI clusters: interview_summary (id, application, start_at, end_at, location, start_date, end_date); interview_details (interviewers, organizer, interview, video_conferencing_url, external_event_id, feedback).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Interview ID",
        is_unique: true,
      },
      application: {
        target_model: "application",
        label: "Application",
      },
      status: enumFieldFromLookupSeedRows(INTERVIEW_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      stage: enumFieldFromLookupSeedRows(INTERVIEW_STAGE_SEED_ROWS, {
        label: "Stage",
      }),
      type: enumFieldFromLookupSeedRows(INTERVIEW_TYPE_SEED_ROWS, {
        label: "Interview Type",
      }),
      created_at: managedField({
        type: "datetime",
        label: "Created At",
      }),
      updated_at: managedField({
        type: "datetime",
        label: "Updated At",
      }),
      start_at: {
        type: "datetime",
        label: "Start At",
      },
      end_at: {
        type: "datetime",
        label: "End At",
      },
      location: {
        type: "text",
        label: "Location",
      },
      external_id: managedField({
        type: "text",
        label: "External ID",
      }),
      // Previously templated.
      start_date: {
        type: "date",
        label: "Start Date",
      },
      end_date: {
        type: "date",
        label: "End Date",
      },
      interviewers: {
        type: "json",
        label: "Interviewers",
      },
      organizer: {
        type: "json",
        label: "Organizer",
      },
      interview: {
        type: "json",
        label: "Interview",
      },
      video_conferencing_url: {
        type: "text",
        label: "Video Conferencing URL",
      },
      external_event_id: {
        type: "text",
        label: "External Event ID",
      },
      feedback: {
        type: "text",
        label: "Feedback",
      },
      remote_id: managedField({
        type: "text",
        label: "Remote ID",
      }),
      remote_created_at: managedField({
        type: "datetime",
        label: "Remote Created At",
      }),
      remote_updated_at: managedField({
        type: "datetime",
        label: "Remote Updated At",
      }),
      remote_was_deleted: managedField({
        type: "bool",
        label: "Remote Was Deleted",
      }),
      field_mappings: managedField({
        type: "json",
        label: "Field Mappings",
      }),
      remote_data: managedField({
        type: "json",
        label: "Remote Data",
      }),
      integration_params: managedField({
        type: "json",
        label: "Integration Params",
      }),
      linked_account_params: managedField({
        type: "json",
        label: "Linked Account Params",
      }),
    },
  },
  {
    name: "offer",
    kind: "entity",
    label: "Offer",
    // Suggested UI clusters: offer_summary (id, application, target_start_date, salary, bonus, equity, currency, expiration_date, sent_at, accepted_at, declined_at, is_accepted); offer_details (creator, offer_letter, offer_letter_file, offer_letter_template, attachments, custom_fields, keyed_custom_fields).
    fields: {
      // Previously essential.
      id: {
        type: "text",
        label: "Offer ID",
        is_unique: true,
      },
      application: {
        target_model: "application",
        label: "Application",
      },
      status: enumFieldFromLookupSeedRows(OFFER_STATUS_SEED_ROWS, {
        label: "Status",
      }),
      target_start_date: {
        type: "date",
        label: "Planned Start Date",
      },
      salary: {
        type: "money_rate",
        label: "Salary",
      },
      total_compensation: managedField({
        type: "money_rate",
        label: "Total Compensation",
      }),
      bonus: { type: "money_rate", label: "Bonus" },
      equity: {
        type: "money_rate",
        label: "Equity",
      },
      currency: { type: "iso_currency", label: "Currency" },
      expiration_date: {
        type: "date",
        label: "Expiration Date",
      },
      sent_at: { type: "datetime", label: "Sent At" },
      accepted_at: {
        type: "datetime",
        label: "Accepted At",
      },
      declined_at: {
        type: "datetime",
        label: "Declined At",
      },
      created_at: managedField({
        type: "datetime",
        label: "Created At",
      }),
      updated_at: managedField({
        type: "datetime",
        label: "Updated At",
      }),
      is_accepted: {
        type: "bool",
        label: "Accepted",
      },
      external_id: managedField({
        type: "text",
        label: "External ID",
      }),
      // Previously templated.
      creator: { type: "json", label: "Creator" },
      offer_letter: {
        type: "json",
        label: "Offer Letter",
      },
      offer_letter_file: {
        type: "json",
        label: "Offer Letter File",
      },
      offer_letter_template: {
        type: "json",
        label: "Offer Letter Template",
      },
      attachments: {
        type: "json",
        label: "Attachments",
      },
      custom_fields: {
        type: "json",
        label: "Custom Fields",
      },
      keyed_custom_fields: {
        type: "json",
        label: "Keyed Custom Fields",
      },
      remote_id: managedField({
        type: "text",
        label: "Remote ID",
      }),
      remote_created_at: managedField({
        type: "datetime",
        label: "Remote Created At",
      }),
      remote_updated_at: managedField({
        type: "datetime",
        label: "Remote Updated At",
      }),
      remote_was_deleted: managedField({
        type: "bool",
        label: "Remote Was Deleted",
      }),
      field_mappings: managedField({
        type: "json",
        label: "Field Mappings",
      }),
      remote_data: managedField({
        type: "json",
        label: "Remote Data",
      }),
      integration_params: managedField({
        type: "json",
        label: "Integration Params",
      }),
      linked_account_params: managedField({
        type: "json",
        label: "Linked Account Params",
      }),
    },
  },
];
