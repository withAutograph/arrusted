# Vercel Better Auth migration runner

Vercel native Git integration remains the only deployer. A Vercel
`vercel.deployment.ready` repository dispatch runs the Auth migration workflow
for the exact deployment identity. Preview never checks out or executes that
untrusted SHA: a no-secret PR workflow produces a SHA-bound additive SQL plan,
and the trusted default-branch runner validates and applies only that plan.
Production proves the dispatched SHA is reachable from the reviewed default
branch before executing it. The workflow does not call the Vercel CLI or API
to deploy, promote, alias, or roll back. Its Production status is the uniquely
named `Vercel - apps: auth-database-migration-production` Deployment Check;
Vercel automatically assigns Production domains only after it passes.

The workflow validates dispatch identity before comparing its project with
`PLATFORM_VERCEL_ROOT_PROJECT_ID` from the `auth-migration` environment. A valid
dispatch for another project is successfully ignored before checkout, tool or
dependency installation, migration, or Auth status reporting. Missing or
conflicting identity fields still fail closed.

## Provider setup

1. In the root `apps` Vercel project, retain native Git integration and automatic
   Production aliasing.
2. Configure Vercel's repository-dispatch integration for
   `vercel.deployment.ready` and add the exact Production GitHub Deployment
   Check name above. Do not routinely bypass it with Force Promote.
3. Create the GitHub `auth-migration` environment without required reviewers.
   Add a project-scoped `NEON_API_KEY`, `BETTER_AUTH_API_KEY`,
   `BETTER_AUTH_SECRET` or `BETTER_AUTH_SECRETS`, and the existing runtime Auth
   configuration needed by the Better Auth CLI. Add non-secret variables
   `PLATFORM_VERCEL_ROOT_PROJECT_ID`, `PLATFORM_NEON_PROJECT_ID`,
   `PLATFORM_PRODUCTION_NEON_BRANCH_ID`, `AUTH_PRODUCTION_DATABASE_IDENTITY`,
   and `BETTER_AUTH_URL`.
4. In the root `apps` Vercel project, configure Production
   `PLATFORM_AUTH_DATABASE_URL` for the dedicated Auth database named in
   `AUTH_PRODUCTION_DATABASE_IDENTITY`, with its same-named restricted role on
   the Neon branch selected by the migration runner. Preserve an existing live
   database name during branding changes; changing a variable name must not
   redirect migrations to a new empty database. `DATABASE_URL` is not the Auth runtime binding.

The runner resolves Production only from the fixed reviewed Neon branch ID. A
Preview with no open PR associated with its exact dispatched commit and branch
is recorded as skipped before Neon access or artifact lookup. The no-secret PR
plan is triggered by Auth source, migration tooling, or workflow changes. The
existing PR Check workflow verifies `packages/auth/migration-inputs.json`
against the Auth dependency closure in `bun.lock`. Unrelated root manifest and
lockfile edits do not start a plan. A dependency change in that closure requires
an updated snapshot, which starts a plan. Preview still validates its isolated
database. For an open PR whose head still
matches the dispatched SHA, the runner checks its complete changed-file list.
When no Auth path changed, it omits the PR artifact but still provisions the
isolated Preview database and validates its schema. A rename from an Auth path
counts as a change. Ambiguous or unreadable PR associations and file inventories
fail closed; a force-pushed PR keeps the exact artifact requirement. Auth-related
Previews still require the full artifact and database validation below.

For Preview, Vercel's native Neon integration creates and owns the isolated
`preview/<git-ref>` branch before its deployment-ready dispatch. The runner
selects only that branch for the dispatched immutable Git ref; a missing,
primary, duplicate, legacy per-app, or wrong-parent branch fails closed. It
then finds the unique no-secret migration-plan artifact named for the dispatched
commit. The artifact's producing workflow run must be a successful `pull_request`
run of `.github/workflows/auth-migration-plan.yml` whose head SHA and branch
match the deployment. If GitHub omits the run’s PR associations, the runner
queries associations for that exact commit instead. Either source must identify
exactly one PR on the dispatched branch, which must still be
open on the same branch. This remains valid when the PR branch was force-pushed
after deployment, because the artifact and workflow run retain the deployed
commit identity. The artifact metadata must still match the dispatched SHA and
selected PR number exactly. The artifact may contain only new `CREATE TABLE` and
`CREATE INDEX` statements; changed existing tables and every destructive or
unsupported statement fail closed for a separate expand/contract release. That lookup never
selects, deploys, or promotes a Vercel deployment. The runner requires the
dedicated direct Auth URI (Production uses the reviewed identity database and
same-named role; Preview uses `platform_auth`), verifies its identity, uses a PostgreSQL
advisory lock, provisions Better Auth, and verifies the final schema.

Only additive, backward-compatible Auth changes are eligible for automatic
execution. Plan destructive changes as a separate expand/contract release.
