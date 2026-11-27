import { ResilientPool } from "@arrusted/core/pool";
import { addPerson, removePerson } from "./server";

export async function runAuthCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [group, action, emailArg, ...rest] = argv;
  if (
    !group ||
    group === "--help" ||
    group === "-h" ||
    group !== "people" ||
    (action !== "add" && action !== "remove") ||
    !emailArg ||
    emailArg.startsWith("--")
  ) {
    const usage = [
      "Usage:",
      "  arrusted-auth people add <email> [--name <name>] [--password <password>] [--org <orgId>] [--schema <auth_schema>]",
      "  arrusted-auth people remove <email> [--org <orgId>] [--schema <auth_schema>]",
    ].join("\n");
    if (group === "--help" || group === "-h" || !group) {
      console.log(usage);
      return;
    }
    throw new Error(usage);
  }

  let name: string | undefined;
  let password: string | undefined;
  let organizationId =
    process.env.AUTH_ORGANIZATION_ID?.trim() ||
    process.env.CUSTOMER_ID?.trim() ||
    process.env.APP_CUSTOMER_ID?.trim();
  let authSchema = process.env.AUTH_SCHEMA?.trim() || undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option ${flag}`);
    }
    i += 1;
    if (flag === "--name") name = value;
    else if (flag === "--password") password = value;
    else if (flag === "--org") organizationId = value;
    else if (flag === "--schema") authSchema = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  const databaseUrl =
    process.env.AUTH_DATABASE_URL?.trim() ||
    process.env.APP_DATABASE_URL?.trim() ||
    process.env.MIGRATION_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("AUTH_DATABASE_URL or APP_DATABASE_URL is required.");
  }
  if (!organizationId) {
    throw new Error(
      "Organization ID is required (--org <orgId> or AUTH_ORGANIZATION_ID / CUSTOMER_ID).",
    );
  }

  const pool = new ResilientPool({ connectionString: databaseUrl, max: 1 });
  try {
    if (action === "add") {
      const added = await addPerson({
        database: pool,
        ...(authSchema ? { authSchema } : {}),
        organizationId,
        email: emailArg,
        ...(name ? { name } : {}),
        ...(password ? { password } : {}),
      });
      if (added.generatedPassword) {
        console.log(
          `Added ${added.email} (${added.userId}) to ${added.organizationId}. Temporary password: ${added.generatedPassword}`,
        );
      } else {
        console.log(`Added ${added.email} (${added.userId}) to ${added.organizationId}.`);
      }
      return;
    }
    const removed = await removePerson({
      database: pool,
      ...(authSchema ? { authSchema } : {}),
      organizationId,
      email: emailArg,
    });
    console.log(
      removed.removed
        ? `Removed ${emailArg} (${removed.userId}) from ${organizationId}.`
        : `No active membership found for ${emailArg} in ${organizationId}.`,
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  runAuthCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
