# Agent-led CSV workspace

`@autograph/csv-workspace` is the browser installation; its `/server` export installs the server service and HTTP handler. Consumers supply domain schema and identity policies, authenticated context, a canonical kernel transport, and model selection. The package owns source parsing, the agent tools and loop, proposal validation, transient draft/conversation state, grid capture, and one atomic Save with exact retry.

```tsx
import { CsvWorkspace } from "@autograph/csv-workspace";
<CsvWorkspace
  baseUrl="/my-app/api/csv-workspace"
  expectedScope={{ appId, customerId }}
  initialAsOf={today}
/>;
```

`CsvWorkspace` owns authenticated loading, effective-date selection before upload,
loading/errors and the shared import UI. Hosts supply scope and route values;
HC and Vendor use this composition. The lower-level `InstalledCsvWorkspace`
also accepts an already loaded context and authenticated client, including
bearer-token or PostgreSQL-backed customer fixtures.

The host initializes AG Grid and its license through `@modules/editable-grid`.
It authenticates requests before invoking the shared handler. App/customer and
actor come from that authenticated principal. The host validates the selected
date and pins the active schema for preparation. Refinement carries the reviewed
schema revision and rejects a changed active schema before invoking the agent;
the user restarts against the new schema. Save carries the reviewed
schema revision and original run date. The host and service enforce the
authenticated recovery context and run date; the canonical kernel validates
the schema revision and individual write dates and owns exact idempotent replay.

```ts
import {
  createCsvWorkspaceService,
  createCsvWorkspaceRequestHandler,
  createPostgresKernelClient,
} from "@autograph/csv-workspace/server";
const service = createCsvWorkspaceService({
  schema,
  schemaRevisionId,
  context: { appId, customerId, actorId, asOf },
  policies: domainIdentityPolicies,
  domainInstructions,
  agent: { model: { provider, model } },
  kernel: createPostgresKernelClient(authenticatedDatabase),
});
const handleAuthorizedRequest = createCsvWorkspaceRequestHandler(service);
```

## Ownership

The neutral PostgreSQL adapter is `packages/kernel-client/postgres.ts`; the HTTP adapter is `packages/kernel-client/http.ts`. Both transport the same canonical operations. HC and Vendor bind their existing authenticated HTTP transports to the public adapter. The CSV service assembles ordinary mainline human apply requests; PostgreSQL owns constraints, atomicity, idempotency, visibility, history and tenant enforcement. No CSV plan language or alternate Save lifecycle is added.

The browser entrypoint does not execute the model, computation runtime or PostgreSQL transport. Consumer imports are restricted to public exports; reusable CSV code cannot import applications or domain libraries. Apps provide ordered identity policy values unchanged. Labels use declared `display_field_id`, an optional domain presentation callback, or record ID. Import-specific change-type metadata is not required.

## Agent and review

The agent inspects schema and policies, reads source/current draft rows, resolves exact identities, coerces canonical values and proposes typed changes. Bounded literal search exposes existing records for exploratory judgment and read-only reference models, without duplicating exact matching semantics. A pure JavaScript computation may produce the same proposal over captured source/draft/grant data in a fresh bounded QuickJS runtime. Both proposal paths use the same shape and identity checks and canonical dry-run. Required fields and other schema/value rules are validated only by the canonical kernel; there is no additional domain-validation callback.

Identity grants return existing values for updates. Create grants consistently return null current values, including repeated resolution and original draft creates; allocated matching evidence is not a persisted record. With isolated computation enabled, `compute_identities` evaluates a pure program over source rows, the original draft, frozen date and existing grants to produce at most 1000 ordinary identity requests. The entire request shape is validated before resolution; larger batches are explicitly rejected. The same exact resolver grants each identity, including duplicate and related identities, and returns compact counts plus at most 30 indexed unresolved issues and the total issue count. Grants and matched `identityCurrentValues` remain tool-side for subsequent computation; matching evidence does not authorize field changes. `compute_draft` consumes these grants and still uses the ordinary proposal and canonical dry-run gate. With computation enabled it is the sole proposal tool, avoiding direct JSON replay of tool-owned IDs; consumers without computation retain `propose_draft`. Grants fix the target record, not its spelling. The complete amended draft, captured grid draft, and every fresh Save validate final identity using the existing domain resolver against the prospective population: stored values plus all patches, clears, and creates. Intentional renames to unused identities remain ordinary edits; missing or conflicting identities are rejected. This is snapshot preflight, not transactional uniqueness enforcement. Canonical schema constraints remain authoritative. Aliases are ordinary policy-declared matching fields. Human edits and explicit clears are captured from the real grid controllers before feedback or Save. The agent cannot publish.

One transient draft is discarded on refresh. Only exact pending Save payloads, keys and originating app/customer/actor/date contexts survive for recovery. Each request has its own browser-storage entry, so concurrent tabs cannot overwrite or clear another request; reload recovers remaining receipts in sequence. The canonical dry-run receipt distinguishes a new write from an already-applied exact request; the shared kernel transport exposes that distinction. Exact replay skips current-population identity preflight, preserving recovery after later record edits or schema activation. Known input and canonical rejections are definitive; transport errors or receipt failures after apply retain the same request for replay. Changing authenticated context resets the mounted draft and aborts an active turn. The receipt is discoverable across default-date changes for the same app/customer/actor; replay always uses its original date and schema revision. History reads canonical saved effects: ordinary human `source_ref = "csv:" + filename` attribution, actor/time, affected records and before/after diffs. No raw file or unfinished conversation is archived.

## Bounds

HTTP request bodies are capped at 3 MiB, with serialized UTF-8 preflight before browser transport; oversized Saves never split into partial commits. Before promoting an agent result, the installed workspace checks that its exact Save body and a continuation containing the same source, returned draft, same instruction and next bounded conversation fit. Oversized results leave the captured previous draft intact. Larger later human edits or instructions remain subject to request preflight. Source and draft tools page at 100 rows; conversation context retains the last eight messages with bounded text. Current lookup populations are loaded into the server in full, and new records require identity grants. Multiple effective dates for one record in a draft or Save are not supported. These are explicit current limitations, not evidence of large-file scalability.

QuickJS executes synchronous code with bounded time, heap, stack and input/output; no host I/O, credentials, network or publishing capability is supplied. This is an interpreter boundary, not an OS sandbox claim. Model interpretation remains probabilistic; captured execution, validation and canonical application are deterministic.

## Validation

Run `mise run test:csv-workspace` for package behavior, unrelated-domain public
composition, presentation and isolated-computation regressions. The laboratory
schema is a package-owned test fixture; no runnable spike app is required.
`mise run test:csv-workspace-installed` exercises the actual authenticated HC and
Vendor installations when their local services and model credentials are available.

Before a computation-enabled turn invokes the model, the expanded source rows and current draft must fit the isolated executor's 4 MiB JSON input ceiling. A CSV below the 3 MiB HTTP limit can exceed that ceiling because parsed rows repeat column names. Such turns are rejected with instructions to remove columns or split the file; model-side batching cannot reduce the captured source. Identity grants added during the turn still share the executor's bounded input budget.

The import preview displays row effective dates as read-only. The selected run date remains the single editable choice before the run starts; ordinary editable-grid consumers retain their date picker. Service validation still rejects any captured or model-supplied date that differs from the run.
