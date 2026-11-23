#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { z } from "zod";
import { readAuthDatabaseResource } from "../../../../packages/auth/database-resource";
import { proposeAuthSchemaMigration } from "./auth-schema-proposal-plan";

// Source-owned producer: public planning input is a resource identity, never a URL.
// Existing targets use a separate private credential file; the fixed worker still
// independently re-plans its actual target before any approved migration.
// Standalone use: auth-protected-propose --input-file <private-frozen-input.json>.
// Supply {resource,catalogAppIds,authOperatorRole?} from the approved platform input: the
// executable has no source checkout from which to infer the application catalog.
// Existing repository callers may continue to supply JSON on stdin.
const inputSchema = z.strictObject({
  resource: z.unknown(),
  directMigrationUrlFile: z.string().min(1).optional(),
  catalogAppIds: z.array(z.string().min(1)).optional(),
  authOperatorRole: z.string().min(1).optional(),
});
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--input-file")) {
    throw new Error("Expected --input-file <path> or JSON stdin");
  }
  const input = inputSchema.parse(JSON.parse(readFileSync(args[1] ?? 0, "utf8")));
  const resource = readAuthDatabaseResource(JSON.stringify(input.resource));
  if (!resource) throw new Error("Auth resource proposal is unavailable");
  const proposal = await proposeAuthSchemaMigration({
    resource,
    ...(input.directMigrationUrlFile === undefined
      ? {}
      : { directMigrationUrlFile: input.directMigrationUrlFile }),
    ...(input.catalogAppIds === undefined ? {} : { catalogAppIds: input.catalogAppIds }),
    ...(input.authOperatorRole === undefined ? {} : { authOperatorRole: input.authOperatorRole }),
  });
  process.stdout.write(`${JSON.stringify(proposal)}\n`);
} catch {
  process.stderr.write("Auth schema proposal could not be produced.\n");
  process.exitCode = 1;
}
