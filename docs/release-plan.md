# Release plan: arrusted 1.0

Goal: a semi-technical person can go from an idea to a deployed, iterable
business app with their own coding agent, with no hosted service in between.

## Where it stands (November 2026)

This tree is the result of a strip-down of a larger multi-app platform.
- **Phases 1–3:** removed the multi-app hosting machinery; added the starter app,
  build-time compile, and safe migrate with restore points and undo.
- **Schema change rules:** one-way archive on removal; type changes refused once a
  field exists.
- **Imports:** a `records:import` CLI for CSV data.

**Tested end to end:** an Opus-class agent, unattended, built two unfamiliar apps
from a plain-English brief:
- **A sales CRM.** The agent built it, imported data, added, renamed and removed
  fields, added a pipeline page, and undid a change. It then went live on Vercel
  and Neon, made a live schema change, recovered from a crash mid-migration, and
  undid that change.
- **A two-shop bakery stock tracker.** 14 steps, about 23 minutes, about $15 of
  model use.

Across both apps the agent needed one human step, and it didn't block the build.

## Release bar

1.0 ships when a new user can, from one starting point:
1. **Name and describe the app.**
2. **Pick their coding agent.** Claude Code, Codex or Cursor, running in their
   own local session.
3. **Store it in GitHub** as a private repo, under a personal account or an org.
4. **Deploy it to Vercel** with Postgres.
5. **Keep iterating** on it the same way, live, with undo.

None of these steps may depend on a service we host.

## Workstreams

### 1. Opening flow (the "create app" experience)
- A local `create` command (or a config file the agent reads) that captures the
  app name, brief, agent, GitHub owner and repo, and whether to deploy.
- **Use credentials the user already has.**
  - Use the `gh` CLI login to create and push the repo.
  - Use the `vercel` CLI login to deploy.
  - Provision Neon through the Vercel Marketplace.
  - Don't require a GitHub App install. Deploy with the Vercel CLI rather than a
    Git-connected project, so no org-level app grant is needed.
- Make agent skills agent-neutral. Today they live in `.claude/skills`; also
  expose them for Codex and Cursor (AGENTS.md plus a shared skills directory).

### 2. Prune to the starter's dependency graph
- Done: removed `agents/reference-resolution`, `app-runtime`, `currency-rates`,
  `dashboard-agent-evals`, `integration-runtime` (with `modules/integrations`),
  `playwright-config` and the TypeScript `domain-libs`. `domain-libs/catalog.json`
  stays: the starter's compile step, the schema-compiler tests and the
  `add-section` skill use it.
- Also audit the non-package directories (`modules`, `design-systems`, `engines`,
  `platform-*`, `provisioning`, `protected-installer`, `rust-auth`,
  `work-session-tools`) against what the starter actually imports.
- Rewrite the historical architecture docs, which still describe the old
  platform, or remove them.
- Then collapse everything into **one npm package** plus the starter template.

### 3. Safety defaults found in testing
- **Credentials:** the agent printed the owner password in chat during first
  deploy. Generate credentials into env files, never echo them, and add a skill
  rule for this.
- **Sign-ups:** after the first owner signs up, sign-up stays open to anyone with
  the link. Make it invite-only by default.
- **Neon:** upstream the retry for connections dropped while Neon wakes (it was
  written during testing and isn't in this tree yet).
- **Undo on managed Postgres** (follow-ups from review):
  - refuse, rather than warn, when the owner administers but doesn't inherit an
    app role;
  - extensions in `public` are dropped by the reset and not archived;
  - add tests for policy roles, `relforcerowsecurity`, column ACLs and type owners.

### 4. Licensing and dependencies
- Done: AG Grid and AG Charts **Community** are the default; Enterprise is an
  optional, user-licensed add-on ([how](ag-enterprise.md)).
- Fix the known vulnerable dependencies the security check reports, starting with
  `better-auth` and `tinypool` (critical).
- Run a third-party licence inventory (`bun.lock`, `Cargo.lock`) before announcing.

### 5. Release engineering
- Strip CI to what this repo needs; drop internal reviewer, branding and
  hosted-deploy checks.
- Add a contributor guide, a security policy and issue templates.
- Add a scripted end-to-end acceptance run that builds the sample CRM and bakery
  apps with an agent and checks the expected numbers. Gate releases on it.
- Use semver tags and a changelog. Publish the npm package under the chosen name.

## Out of scope for 1.0
- Multi-app hosting, a hosted builder, and org and app provisioning services.
- Integrations beyond `importRecords()` and CSV import.
