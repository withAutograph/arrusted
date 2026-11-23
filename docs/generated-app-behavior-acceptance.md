# Generated app behavior acceptance

Compilation and repository checks do not establish application behavior. The
first behavior fixture exercises authenticated Spend Review locally, using its
checked CUE release, Better Auth password sessions, existing Server Actions and
generated PostgreSQL reads. It does not generate or repair a candidate app.

The initial local run observed a submission-navigation failure. The complete
workflow is not yet accepted.

## Run local acceptance

Use an isolated worktree with repository-pinned dependencies and Playwright
Chromium installed. Supply a disposable loopback PostgreSQL server whose operator
can create databases and roles:

```sh
SPEND_REVIEW_QA_CLUSTER_URL=postgres://operator@127.0.0.1:5432/postgres \
  mise //apps/spend-review:test-local-acceptance
```

The task creates uniquely named auth and app databases, five Better Auth users,
two organizations, and a restricted runtime login. It creates accounts through
the real signup handler, removes automatic `dev` membership only from these
fixture users, binds exact organization and application roles, and signs in
normally. Credentials and browser sessions stay in memory. App dotenv files and
hosted execution are refused because they can import unrelated provider/database
credentials into a disposable local test. No shared setup, existing database,
other daemon namespace, demo bypass, or provider activation is used.

| Fixture alias | Organization | App role | Required behavior                             |
| ------------- | ------------ | -------- | --------------------------------------------- |
| requester     | A            | member   | Submit and read own requests                  |
| otherMember   | A            | member   | Cannot view or decide the requester's records |
| reviewer      | A            | reviewer | Decide others' requests; cannot approve own   |
| unassigned    | A            | none     | Cannot access the app or submit decisions     |
| otherTenant   | B            | reviewer | Cannot read or decide A's records             |

A separate signed-out browser context exercises authentication denial. Both
tenants share one app database and restricted runtime login, so physical database
separation cannot accidentally supply the tenant-isolation guarantee.

Browser creation and decisions require independent request, decision and audit
readback through a separate restricted connection. Denial assertions replay a
captured real Server Action with other sessions and record IDs; they require a
safe denial and an unchanged persisted snapshot. Hidden controls alone do not
prove write authorization. Same-tenant private visibility is enforced by the
app's feature read boundary; cross-tenant scope is also checked by the generated
database operations.

Restart acceptance stops the suite-owned Next development process, confirms its
exit and listener closure, starts a new process against the same database, and
opens a fresh browser context. The rendered record and independent persisted
snapshot must survive. This is local app-process proof, not a database restart,
compute replacement, deployed Gateway, Preview or Production claim. The local
auth adapter serves the repository's actual Better Auth handler; it does not
exercise hosted Gateway delegation.

## Result contract and retention

Each invocation uses a new run/attempt ID and private temporary output directory.
`SPEND_REVIEW_QA_OUTPUT` may select a new external directory; existing directories
are never overwritten. Keep every attempt, including failures and retries.
The task prints only its verdict and report path. It makes no model calls.

Portable `report.json` has `kind: generated-app-behavior/v1`, `runId`,
`attemptId`, `scenario`, `environment`, `source`, `status`, `assertions`, and
`unassessed`. `source` binds the Git revision, tested app/auth/runtime and
acceptance source digest, relevant dependency/workspace configuration, and
checked release identity/hash. Next's generated `next-env.d.ts` declaration is
excluded because native development startup rewrites its build-directory hint.
Each assertion records `id`, `status`, `reason`, `observedAt`, and safe `evidence`
facts. Readback is represented by a digest; restart records process identities
and source/database continuity. `assertions.jsonl` retains completed assertions
as they occur, even if a later step fails.

| Status     | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| passed     | The named assertion was exercised successfully            |
| failed     | Exercised behavior or fixture setup violated its contract |
| blocked    | Required execution infrastructure was unavailable         |
| unassessed | The behavior was not exercised                            |

Failure takes precedence over blocked, then unassessed, in the run verdict.
A prior failed observation cannot be replaced with a pass. Runtime logs retain
only known route/status facts and a fixed uncached-render diagnostic. Raw
exceptions, credentials, cookies and connection strings never enter portable
results. Screenshots contain the synthetic local test view. Cleanup attempts all
suite-owned resources and is itself a reported assertion; failure prevents a
passing run. The caller owns the disposable PostgreSQL server lifecycle.

Source edits, release changes, fixture reassignment or an unrelated runtime
require new evidence. Prior receipts retain their original verdict. A planned,
failed or unobserved restart provides no persistence credit. The public acceptance
driver owns generation, scenario scheduling and recovery; it may consume this
receipt as local repository acceptance but cannot relabel it as public Builder
generation proof. Builder's internal JSON action/readback evidence is a separate,
narrower evidence class.

Protected Preview remains separately approved, with hosted identities, provider
readback and data/migration authority. Follow the
[Production handoff](operations/generated-app-production.md).
