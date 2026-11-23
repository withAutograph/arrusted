# Task-first information composition

Apply this to every new page and every material revision. It shapes design
choices; it is not a checklist, a template or a score.

## Compose meaning before containers

Identify the person's immediate task, the information needed to do it, and the
next useful action. Give each piece a role: identity, status, evidence, input,
recommendation, action, or supporting metadata. Arrange those roles for this
task rather than filling cards or copying another page's layout.

- Separate page purpose from workload counts, sorting, instructions and record
  metadata. Counts, filters and sorting belong with their collection; help
  belongs beside the field or action it explains. A subtitle is not a
  catch-all sentence. Omit instructions that state the obvious.
- Build hierarchy with the shared typography, spacing and surfaces. Do not
  enlarge everything, shrink needed text to unreadable sizes, or override the
  palette.
- Group by proximity and descriptive headings; separate groups more clearly
  than items within a group. Status needs words, not color alone. Never invent
  thresholds or business definitions to make a grouping sound authoritative.
- Make rows comparable: emphasize identity and the task's deciding fields;
  subordinate identifiers and metadata. Not every fact is a badge.
- Keep the evidence for one decision visible together. Tabs are for distinct
  tasks or substantial alternate views, not for splitting three related
  fields. Decide what is "secondary" by its role in the decision, not its
  name: a cost or a deadline can be the deciding fact.
- Detail views answer a question. For a decision: issue and evidence, then the
  recommendation, then the action. For a result: lead with the outcome, keep
  the baseline nearby when the change matters. For reference data: identity
  and navigable facts first.
- Keep state language consistent across the selected record, evidence,
  recommendation, action and confirmation. Acknowledged is not approved;
  recommended is not resolved.
- Keep the primary action near the information that justifies it, and say what
  it will do.
- A number that supports a decision shows its basis beside it: unit, period or
  as-of date, and the comparison (plan, prior value, denominator). A
  percentage or total without its base is incomplete.

## Make the next step legible

- Distinguish selecting a row from opening it or starting an action. Use a
  real link or row action when selection alone is unclear.
- If the page pre-selects a record, label it as a suggestion.
- When ordering matters, label its basis next to the results ("Sorted by:
  newest") and keep it stable when filters change. A passive label must not
  look like a control; a changeable sort uses a real control.
- Summarize a consequential outcome near its heading, then show the evidence.
  Do not repeat one warning as a badge, a heading and a paragraph.
- Let action areas handle long labels and narrow panels by wrapping or
  stacking, not by clipping, tiny text or fixed heights.
- Size simple controls for their content; let comparison tables use the width.
  Bound prose to a comfortable reading measure.
- In an action panel below page chrome, keep the action and its full feedback
  reachable in a short window.
- Related panes share one empty-state story. Distinguish "nothing matches your
  filter" from "nothing selected", and offer the relevant recovery.

## Different tasks, different compositions

| Task | Useful organization | Avoid |
| --- | --- | --- |
| Review an exception | Priority groups; deciding fields; evidence and action together | A generic dashboard or tabs hiding the deciding facts |
| Submit a request | Related field groups; help beside fields; summary and submit | Metric cards, severity groups, a queue copied from elsewhere |
| Compare performance | Scope and time context; comparison and trend; drill-in | Headline numbers with no comparison basis |
| Find and edit a record | Search and identity; structured facts; clear edit/save/cancel | Treating reference data as a risk assessment |
| Track a pipeline | Stages as columns or groups with counts and totals; owner visible | Burying stage in a detail panel |

## The app's existing look is the visual foundation

Use what the app already has: Canvas for seeing and editing a table's rows,
and for custom pages semantic HTML with the classes in `app/app/styles.css`,
following the Overview page. Ordinary layout, data mapping and state wiring
are composition, not new design. (The shared component library in
`packages/design-systems/core` is not wired into `app/` yet; do not add it
without the builder's go-ahead.)

If a capability is genuinely missing: adapt with what exists, tell the builder
what you could not show, and keep any new class in `styles.css` small and
consistent with its existing colors, spacing and radii.

## Carry the design into the real build

When sample data becomes real data, keep the reviewed information roles,
composition, hierarchy and interactions. Change bindings, not the design.
