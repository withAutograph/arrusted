# Import Principles

This document is the current contract for agent-led CSV workspaces. Historical
plans record the superseded plan/compiler/session architecture; they are not
current implementation authority.

## Product contract

A CSV import is one agent-assisted editing workspace over ordinary typed record
writes:

1. The human chooses a CSV file and effective date.
2. The agent inspects the active schema, source rows, current draft, saved
   records, and domain identity policy through bounded tools.
3. The agent proposes one replacement draft. The human reviews and edits that
   draft in the real grid and may ask the agent to refine it. Each refinement
   receives the current grid edits, so untouched human work is preserved.
4. Canonical dry-run validation gates the draft.
5. One explicit human Save submits all rows in one mainline
   `ApplyChangeSet`. The kernel owns authorization, validation, idempotency,
   atomicity, and persistence.

The agent is essential to preparation. There is no CSV plan DSL, accepted-plan
compiler lifecycle, alias-confirmation protocol, or durable unfinished import
session. The optional computation tool runs synchronous pure JavaScript over
captured source, draft, date, and identity-grant data in an isolated bounded
runtime. It produces the same proposal shape as the ordinary agent tool and has
no host I/O, network, credentials, or Save capability.
The same executor can produce up to 1,000 ordinary identity requests in a batch.
They use the existing exact resolver; grants and matched current values stay
tool-side for draft computation instead of being copied through model output.

## Draft, feedback, and Save

There is exactly one transient draft. It is the shared editing buffer for agent
proposals and human grid edits. Before feedback or Save, mounted grid
controllers capture the user's current edits. A new accepted proposal replaces
the prior attempt relative to that captured draft; it is not a durable plan or
a second source of truth. Refresh discards the unfinished draft and bounded
conversation.

Save is the only durable transition. Immediately before the request, the
browser retains an exact pending-Save receipt containing:

- the stable idempotency key;
- the serialized draft payload;
- the authenticated app, customer, and actor context;
- the frozen effective date;
- the reviewed schema revision; and
- the source filename.

While that receipt exists, editing and new imports are blocked. A refresh offers
only retry of that exact request. A canonical `not_applied` rejection clears the
receipt; transport uncertainty or a missing post-apply receipt retains it for
same-key replay. This recovery receipt is not an unfinished-session store.

Successful imports use ordinary human attribution:
`source_kind = "human"` and `source_ref = "csv:<filename>"`. Recent imports are
derived from canonical activity, and their details come from the canonical
change-set diff. Do not add an import history or session database for facts the
kernel already owns.

## Identity and reference context

Ordered identity policy is domain authority and is exported by `packages/domain-libs/`.
Apps pass those policies unchanged to the reusable workspace. Exact matching
and UUID allocation happen through the workspace identity tool; proposal rows
must preserve its target grants. The complete amended draft, captured grid
draft, and fresh Save check final identity against the prospective population
using that same resolver. Updates combine stored values with all proposed
patches and clears; creates must author identity values. Intentional renames
to unused identities are allowed; missing or conflicting identities are not.
This snapshot preflight does not replace transactional schema constraints.
Canonical dry-run detects exact applied replays before this live check, so
later record edits do not prevent recovery of an already committed Save.

Models without an identity policy are still searchable read-only reference
context. They are not authorable merely because the active schema exposes
them. Aliases are ordinary fields only when the domain policy declares them as
identity evidence; there is no special confirmation machine or hidden identity
store. `external_key` remains a kernel addressing mechanism, not inferred CSV
business identity.

## Authority and layering

- The kernel and app write guards remain authoritative. Reusable TypeScript may
  decode proposal shape, enforce identity grants, and call the canonical dry-run, but it cannot create a privileged write path.
- `packages/csv-workspace` is the public browser/server product boundary. It
  owns parsing, bounded tools, agent execution, transient draft handling, grid
  capture, exact Save recovery, canonical transport composition, and history
  presentation.
- `packages/modules/source-import` retains reusable source intake and
  grid-preview presentation leaves only. It owns no workflow, identity,
  compiler, session, or Save authority.
- Apps own authentication and origin checks, tenant/app/actor binding, the
  frozen date, active schema revision, domain instructions, identity policies,
  model selection and canonical kernel transport.
  HC and Vendor contain concrete adapters for this contract.
- The deleted `packages/agents/csv`, `packages/csv-import-host`, and
  `packages/engines/csv-derivation` boundaries must not be referenced as current
  architecture. Identity matching is `resolveImportIdentity`; there is no
  upstream identity-graph classifier.

Separate universal kernel durable-import APIs remain valid substrate. They are
not the state model for this interactive CSV workspace and must not be removed
or reinterpreted to manufacture workspace resume behavior.

## Current limits

The HTTP handler caps request bodies at 3 MiB. Source and draft tools page at
100 rows; conversation retains only a bounded recent window; current record
populations are loaded server-side; and one turn cannot author multiple
effective dates for the same record. The isolated JavaScript executor also has
time, memory, stack, and I/O limits.
The history view shows imports among the latest 30 human activity entries.
Tenant custom-field authoring is outside the initial workspace draft contract.

These are explicit constraints, not a scalability claim. Installed HC and Vendor
flows have passed local live acceptance. Subsequent shared repairs have
deterministic regression coverage; the migration report distinguishes their
package fingerprints. Hosted deployment acceptance is not established.
