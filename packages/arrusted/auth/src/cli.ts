import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ResilientPool } from "@arrusted/core/pool";
import { addPerson, removePerson } from "./server";

const validAuthSchema = /^(?:public|auth_[a-z0-9_]{1,57})$/u;

function assertNotSymbolicLink(targetPath: string, label: string): void {
  const entry = lstatSync(targetPath, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write credentials through symbolic link (${label}): ${targetPath}`,
    );
  }
}

function ensureLocalGitignore(localDir: string): void {
  const gitignorePath = path.join(localDir, ".gitignore");
  assertNotSymbolicLink(gitignorePath, ".local/.gitignore");
  if (existsSync(gitignorePath)) return;
  try {
    writeFileSync(gitignorePath, "*\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw error;
    }
  }
  assertNotSymbolicLink(gitignorePath, ".local/.gitignore");
}

export function encodeEmailForCredentialFilename(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return "user";
  let encoded = "";
  for (const byte of Buffer.from(normalized, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/^[a-z0-9._@-]$/u.test(ch)) {
      encoded += ch;
    } else {
      encoded += `%${byte.toString(16).padStart(2, "0")}`;
    }
  }
  if (encoded.length > 180) {
    const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return `${encoded.slice(0, 140)}-${digest}`;
  }
  return encoded;
}

export function writeGeneratedPasswordFile(
  email: string,
  secret: string,
  authSchema: string = "public",
  cwd: string = process.cwd(),
): string {
  const resolvedSchema = authSchema.trim() || "public";
  if (!validAuthSchema.test(resolvedSchema)) {
    throw new Error(
      "Auth schema must be 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const baseDir = path.resolve(cwd);
  // Allow the project directory itself (or its parent mount) to reside under a user/OS symlink,
  // while strictly rejecting symbolic links anywhere beneath cwd (.local, .gitignore, credentials, file).
  const canonicalBaseDir = realpathSync(baseDir);
  if (!statSync(canonicalBaseDir).isDirectory()) {
    throw new Error(`Working directory must be an existing directory: ${baseDir}`);
  }

  const localRoot = path.join(baseDir, ".local");
  assertNotSymbolicLink(localRoot, ".local directory");
  mkdirSync(localRoot, { recursive: true, mode: 0o700 });
  assertNotSymbolicLink(localRoot, ".local directory");
  if (!lstatSync(localRoot).isDirectory()) {
    throw new Error(`Credentials .local path must be a real directory: ${localRoot}`);
  }
  chmodSync(localRoot, 0o700);
  ensureLocalGitignore(localRoot);

  const parentDir = path.join(localRoot, "credentials");
  assertNotSymbolicLink(parentDir, "credentials directory");
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  assertNotSymbolicLink(parentDir, "credentials directory");
  if (!lstatSync(parentDir).isDirectory()) {
    throw new Error(`Credentials parent path must be a real directory: ${parentDir}`);
  }
  chmodSync(parentDir, 0o700);

  const safeStem = encodeEmailForCredentialFilename(email);
  const targetPath = path.join(parentDir, `${resolvedSchema}--${safeStem}.txt`);
  assertNotSymbolicLink(targetPath, "credential file");
  const existingTarget = lstatSync(targetPath, { throwIfNoEntry: false });
  if (existingTarget?.isDirectory()) {
    throw new Error(`Password file path is a directory: ${targetPath}`);
  }

  const tmpPath = path.join(parentDir, `.cred-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tmpPath, 0o600);
    assertNotSymbolicLink(targetPath, "credential file");
    renameSync(tmpPath, targetPath);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
  return targetPath;
}

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
      "  arrusted-auth people add <email> [--name <name>] [--org <orgId>] [--schema <auth_schema>]",
      "  arrusted-auth people remove <email> [--org <orgId>] [--schema <auth_schema>]",
    ].join("\n");
    if (group === "--help" || group === "-h" || !group) {
      console.log(usage);
      return;
    }
    throw new Error(usage);
  }

  let name: string | undefined;
  let organizationId =
    process.env.AUTH_ORGANIZATION_ID?.trim() ||
    process.env.CUSTOMER_ID?.trim() ||
    process.env.APP_CUSTOMER_ID?.trim();
  let authSchema = process.env.AUTH_SCHEMA?.trim() || undefined;

  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    if (flag === "--password" || flag === "--password-file") {
      throw new Error(
        `Unknown option: ${flag} ('people add' always writes a generated temporary password to .local/credentials/<auth_schema>--<email>.txt).`,
      );
    }
    const value = rest[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for option ${flag}`);
    }
    i += 1;
    if (flag === "--name") name = value;
    else if (flag === "--org") organizationId = value;
    else if (flag === "--schema") authSchema = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (action === "remove" && name !== undefined) {
    throw new Error("--name is only valid with 'people add'.");
  }

  const databaseUrl = process.env.AUTH_DATABASE_URL?.trim() || process.env.APP_DATABASE_URL?.trim();
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
      let writtenPath: string | undefined;
      const resolvedSchema = authSchema ?? "public";
      const added = await addPerson({
        database: pool,
        ...(authSchema ? { authSchema } : {}),
        organizationId,
        email: emailArg,
        ...(name ? { name } : {}),
        onGeneratedPassword: (generatedPassword, resolvedEmail) => {
          writtenPath = writeGeneratedPasswordFile(
            resolvedEmail,
            generatedPassword,
            resolvedSchema,
          );
        },
      });
      if (writtenPath) {
        console.log(
          `Added ${added.email} (${added.userId}) to ${added.organizationId}. Temporary password written to ${writtenPath}`,
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
