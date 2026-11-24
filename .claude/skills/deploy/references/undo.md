# Undo the last schema change

Explain that undo restores app records and schema to just before the last
migration: later record edits are lost. Current Auth accounts, sessions,
memberships and OAuth grants survive. Confirm that this is the builder's intent
and that the recorded restore point is still available.

From `app/`, for production run:

```sh
bun run migrate:undo --production
```

(For a local database, run `bun run migrate:undo`.)

The builder runs this themselves in their terminal and types the app name to
confirm. Then revert the source to match the commit it prints: make a revert PR with
`ship-change`, get a yes, merge it, and run `bun run release`. Until that release
the live code may not match the data, so do it straight away. Never apply an old
schema as a forward migration. Check restored records in the app. For code-only
changes with no migration, revert by PR and release; leave the database alone.
