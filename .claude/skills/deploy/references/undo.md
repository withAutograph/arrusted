# Undo the last schema change

Explain that undo restores app records and schema to just before the last
migration: later record edits are lost. Current Auth accounts, sessions,
memberships and OAuth grants survive. Confirm that this is the builder's intent
and that the recorded restore point is still available.

From `app/`, run:

```sh
bun --env-file=.env.local --env-file=.env.migrate run migrate:undo
```

Use the matching source commit printed by the command, including saved dirty
source files if it reports them. Redeploy that source with `vercel deploy --prod`;
do not apply an old schema as a forward migration. Check restored records in the
app. For code-only changes with no migration, redeploy the matching earlier
commit without undoing a database migration.
