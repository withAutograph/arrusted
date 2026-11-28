import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ResilientPool } from "@arrusted/core/pool";
import { addPerson, removePerson } from "./server";

const DARWIN_SYSTEM_ROOT_SYMLINKS = new Set(["/var", "/tmp", "/etc"]);

function assertNotSymbolicLink(targetPath: string, label: string): void {
  if (process.platform === "darwin" && DARWIN_SYSTEM_ROOT_SYMLINKS.has(targetPath)) {
    return;
  }
  if (!existsSync(targetPath)) {
    const dangling = lstatSync(targetPath, { throwIfNoEntry: false });
    if (dangling?.isSymbolicLink()) {
      throw new Error(
        `Refusing to write credentials through symbolic link (${label}): ${targetPath}`,
      );
    }
    return;
  }
  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to write credentials through symbolic link (${label}): ${targetPath}`,
    );
  }
}

function assertNoSymlinkAncestors(dirPath: string): void {
  const resolved = path.resolve(dirPath);
  const parsed = path.parse(resolved);
  const remainder = resolved.slice(parsed.root.length);
  let cursor = parsed.root;
  for (const segment of remainder.split(path.sep)) {
    if (!segment) continue;
    cursor = path.join(cursor, segment);
    assertNotSymbolicLink(cursor, "credentials path ancestor");
  }
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
  explicitPath?: string,
  cwd: string = process.cwd(),
): string {
  const safeStem = encodeEmailForCredentialFilename(email);
  const targetPath = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.resolve(cwd, ".local/credentials", `${safeStem}.txt`);
  const parentDir = path.dirname(targetPath);

  assertNoSymlinkAncestors(parentDir);
  if (!explicitPath) {
    const localRoot = path.resolve(cwd, ".local");
    mkdirSync(localRoot, { recursive: true, mode: 0o700 });
  }
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(parentDir);

  const parentStat = lstatSync(parentDir);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error(`Credentials parent path must be a real directory: ${parentDir}`);
  }
  if (!explicitPath) {
    chmodSync(parentDir, 0o700);
  }

  const existingTarget = lstatSync(targetPath, { throwIfNoEntry: false });
  if (existingTarget?.isSymbolicLink()) {
    throw new Error(`Refusing to overwrite symbolic link with credentials: ${targetPath}`);
  }
  if (existingTarget?.isDirectory()) {
    throw new Error(`Password file path is a directory: ${targetPath}`);
  }

  const tmpPath = path.join(parentDir, `.cred-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(tmpPath, 0o600);
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
      "  arrusted-auth people add <email> [--name <name>] [--password <password> | --password-file <path>] [--org <orgId>] [--schema <auth_schema>]",
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
  let passwordFile: string | undefined;
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
    else if (flag === "--password-file") passwordFile = value;
    else if (flag === "--org") organizationId = value;
    else if (flag === "--schema") authSchema = value;
    else throw new Error(`Unknown option: ${flag}`);
  }

  if (
    action === "remove" &&
    (name !== undefined || password !== undefined || passwordFile !== undefined)
  ) {
    throw new Error("--name, --password, and --password-file are only valid with 'people add'.");
  }
  if (password !== undefined && passwordFile !== undefined) {
    throw new Error("--password and --password-file cannot be combined.");
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
      const added = await addPerson({
        database: pool,
        ...(authSchema ? { authSchema } : {}),
        organizationId,
        email: emailArg,
        ...(name ? { name } : {}),
        ...(password ? { password } : {}),
        onGeneratedPassword: (generatedPassword, resolvedEmail) => {
          writtenPath = writeGeneratedPasswordFile(resolvedEmail, generatedPassword, passwordFile);
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
