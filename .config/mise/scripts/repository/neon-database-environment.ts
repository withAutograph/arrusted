import { createHmac } from "node:crypto";

import { Pool, type PoolClient } from "pg";

export type DeploymentDatabaseSpec = {
  database: string;
  owner: string;
  role: string;
};

export type NeonBranch = {
  id: string;
  name: string;
  parent_id?: string | null;
  primary?: boolean;
};

export type NeonDatabase = {
  branch_id: string;
  name: string;
  owner_name: string;
};

export type NeonRole = {
  branch_id: string;
  name: string;
};

export type NeonOperation = {
  id: string;
  status: string;
};

export type NeonApi = (pathname: string, init?: RequestInit) => Promise<unknown>;

export type DatabaseConnectionFactory = (
  spec: DeploymentDatabaseSpec,
  pooled: boolean,
) => Promise<string>;

type DatabaseIdentityProbePool = {
  connect: () => Promise<{
    query: (queryText: string) => Promise<{
      rows: {
        database: string;
        neon_superuser: boolean;
        role: string;
      }[];
    }>;
    release: () => void;
  }>;
  end: () => Promise<void>;
};

export class DatabaseConnectDeniedError extends Error {
  constructor(database: string) {
    super(`permission denied for database ${database}`);
    this.name = "DatabaseConnectDeniedError";
  }
}

const OWNER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/u;
const POSTGRES_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const NEON_STARTUP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const NEON_CONNECTION_ATTEMPT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

export function previewBranchName(gitRef: string): string {
  if (
    !/^(?!\/)(?!.*\/$)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*\[\\\s])[A-Za-z0-9._/-]+$/u.test(
      gitRef,
    )
  ) {
    throw new Error("Vercel Preview git ref is invalid");
  }
  return `preview/${gitRef}`;
}

export function previewBranchCreateRequest(
  name: string,
  productionBranchId: string,
  expiresAt: string,
): {
  branch: { expires_at: string; name: string; parent_id: string };
  endpoints: [{ suspend_timeout_seconds: number; type: "read_write" }];
} {
  return {
    branch: { name, parent_id: productionBranchId, expires_at: expiresAt },
    endpoints: [{ type: "read_write", suspend_timeout_seconds: 0 }],
  };
}

export function selectPreviewBranch(
  gitRef: string,
  branches: readonly NeonBranch[],
  productionBranchId: string,
): NeonBranch | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(productionBranchId)) {
    throw new Error("production Neon branch identifier is invalid");
  }
  const expected = previewBranchName(gitRef);
  const legacyPerApp = branches.filter(({ name }) => name.startsWith(`${expected}/`));
  if (legacyPerApp.length > 0) {
    throw new Error(
      `one Neon branch per app is forbidden; found ${legacyPerApp.map(({ name }) => name).join(", ")}`,
    );
  }
  const matches = branches.filter(({ name }) => name === expected);
  if (matches.length > 1) throw new Error(`Neon returned duplicate preview branch ${expected}`);
  if (matches[0]?.primary === true) {
    throw new Error(`preview branch ${expected} must not be the primary Neon branch`);
  }
  if (matches[0] && matches[0].parent_id !== productionBranchId) {
    throw new Error(`preview branch ${expected} must clone the reviewed production branch`);
  }
  return matches[0];
}

export function selectProductionBranch(
  expectedBranchId: string,
  branches: readonly NeonBranch[],
): NeonBranch {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(expectedBranchId)) {
    throw new Error("production Neon branch identifier is invalid");
  }
  const primary = branches.filter(({ primary }) => primary === true);
  if (primary.length !== 1 || primary[0]!.id !== expectedBranchId) {
    throw new Error(
      "Neon primary branch does not match the reviewed production project/branch identity",
    );
  }
  return primary[0]!;
}

export function deploymentDatabaseSpecifications(
  applicationOwners: readonly string[],
): readonly DeploymentDatabaseSpec[] {
  const owners = ["auth", ...applicationOwners].toSorted();
  if (applicationOwners.length === 0) {
    throw new Error("deployment database topology requires at least one stateful application");
  }
  if (new Set(owners).size !== owners.length) {
    throw new Error("deployment database owners must be unique and Auth must not be app-owned");
  }
  return owners.map((owner) => {
    if (!OWNER_PATTERN.test(owner)) {
      throw new Error(`deployment database owner is invalid: ${owner}`);
    }
    const identifier = `platform_${owner.replaceAll("-", "_")}`;
    if (!POSTGRES_IDENTIFIER_PATTERN.test(identifier)) {
      throw new Error(`derived deployment database identifier is invalid: ${identifier}`);
    }
    return { database: identifier, owner, role: identifier };
  });
}

export function validateDatabaseOwnership(
  branchId: string,
  specs: readonly DeploymentDatabaseSpec[],
  databases: readonly NeonDatabase[],
  roles: readonly NeonRole[],
): void {
  const expectedDatabases = new Set(specs.map(({ database }) => database));
  const expectedRoles = new Set(specs.map(({ role }) => role));
  if (
    expectedDatabases.size !== specs.length ||
    expectedRoles.size !== specs.length ||
    specs.some(({ database, role }) => database !== role)
  ) {
    throw new Error("deployment database topology contains shared database or role identities");
  }
  for (const database of databases.filter(({ name }) => expectedDatabases.has(name))) {
    if (database.branch_id !== branchId) {
      throw new Error(`database ${database.name} belongs to another Neon branch`);
    }
    const expected = specs.find(({ database: name }) => name === database.name);
    if (!expected || database.owner_name !== expected.role) {
      throw new Error(
        `database ${database.name} must be owned by role ${expected?.role ?? "unknown"}`,
      );
    }
  }
  for (const role of roles.filter(({ name }) => expectedRoles.has(name))) {
    if (role.branch_id !== branchId) {
      throw new Error(`role ${role.name} belongs to another Neon branch`);
    }
  }
}

export function databaseAccessStatements(
  specs: readonly DeploymentDatabaseSpec[],
  databaseNames: readonly string[],
): readonly string[] {
  const uniqueDatabases = [...new Set(databaseNames)];
  if (uniqueDatabases.length !== databaseNames.length || uniqueDatabases.length === 0) {
    throw new Error("deployment database inventory must contain unique databases");
  }
  const roleStatements = specs.flatMap((spec) => [
    neonSuperuserRevocationStatement(spec.role),
    `ALTER ROLE ${quoteIdentifier(spec.role)} NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `ALTER ROLE ${quoteIdentifier(spec.role)} RESET search_path`,
  ]);
  const retainedDatabaseStatements = uniqueDatabases.flatMap((database) => {
    const owner = specs.find((spec) => spec.database === database);
    if (owner) return [];
    return [
      `REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`,
      ...specs.map(
        ({ role }) =>
          `REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM ${quoteIdentifier(role)}`,
      ),
    ];
  });
  return [...roleStatements, ...retainedDatabaseStatements];
}

export function databaseCredentialStatements(
  specs: readonly DeploymentDatabaseSpec[],
  passwords: ReadonlyMap<string, string>,
): readonly string[] {
  return specs.map((spec) => {
    const password = passwords.get(spec.owner);
    if (!password || password.length < 32) {
      throw new Error(`database password is missing or too short for ${spec.owner}`);
    }
    return `ALTER ROLE ${quoteIdentifier(spec.role)} PASSWORD ${quoteLiteral(password)}`;
  });
}

export function databaseOwnerAccessStatements(
  owner: DeploymentDatabaseSpec,
  specs: readonly DeploymentDatabaseSpec[],
): readonly string[] {
  if (
    !specs.some(
      (spec) =>
        spec.owner === owner.owner && spec.database === owner.database && spec.role === owner.role,
    )
  ) {
    throw new Error(`database owner is not in the reviewed allowlist: ${owner.owner}`);
  }
  return [
    `REVOKE CONNECT ON DATABASE ${quoteIdentifier(owner.database)} FROM PUBLIC`,
    ...specs
      .filter((spec) => spec.role !== owner.role)
      .map(
        ({ role }) =>
          `REVOKE CONNECT ON DATABASE ${quoteIdentifier(owner.database)} FROM ${quoteIdentifier(role)}`,
      ),
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(owner.database)} TO ${quoteIdentifier(owner.role)}`,
  ];
}

export function roleOwnershipTransferStatements(
  fromRole: string,
  toRole: string,
): readonly string[] {
  if (
    !POSTGRES_IDENTIFIER_PATTERN.test(fromRole) ||
    !POSTGRES_IDENTIFIER_PATTERN.test(toRole) ||
    fromRole === toRole
  ) {
    throw new Error("role ownership transfer requires distinct valid role identifiers");
  }
  return [
    `REASSIGN OWNED BY ${quoteIdentifier(fromRole)} TO ${quoteIdentifier(toRole)}`,
    `DROP OWNED BY ${quoteIdentifier(fromRole)}`,
  ];
}

export function maskDatabaseConnection(connectionString: string): void {
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::add-mask::${connectionString}\n`);
  }
}

export async function runMaskedDatabaseTransaction(
  connectionString: string,
  statements: readonly string[],
): Promise<void> {
  maskDatabaseConnection(connectionString);
  const { client, pool } = await connectToNeonDatabase(connectionString);
  try {
    try {
      await client.query("BEGIN");
      for (const statement of statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function retryNeonStartupConnection<T>(
  connect: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await connect();
    } catch (error) {
      const delay = NEON_STARTUP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isNeonStartupConnectionError(error)) throw error;
      process.stderr.write(
        `Neon compute is not accepting connections yet; retrying in ${delay}ms\n`,
      );
      await wait(delay);
    }
  }
}

async function connectToNeonStartup(pool: DatabaseIdentityProbePool) {
  const client = await retryNeonStartupConnection(() => pool.connect());
  return client;
}

export async function probeDatabaseIdentity(
  connectionString: string,
  pool: DatabaseIdentityProbePool = new Pool({ connectionString, max: 1 }),
): Promise<{ database: string; neonSuperuser: boolean; role: string }> {
  maskDatabaseConnection(connectionString);
  let client;
  try {
    try {
      client = await connectToNeonStartup(pool);
    } catch (error) {
      if (isRecord(error) && error.code === "42501") {
        throw new DatabaseConnectDeniedError(new URL(connectionString).pathname.slice(1));
      }
      throw error;
    }
    const result = await client.query(
      "select current_database() as database, current_user as role, pg_has_role(current_user, 'neon_superuser', 'member') as neon_superuser",
    );
    const row = result.rows[0];
    if (!row) throw new Error("database identity probe returned no row");
    return {
      database: row.database,
      neonSuperuser: row.neon_superuser,
      role: row.role,
    };
  } finally {
    client?.release();
    await pool.end();
  }
}

async function connectToNeonDatabase(connectionString: string): Promise<{
  client: PoolClient;
  pool: Pool;
}> {
  for (let attempt = 0; ; attempt += 1) {
    const pool = new Pool({ connectionString, max: 1 });
    try {
      return { client: await pool.connect(), pool };
    } catch (error) {
      await pool.end();
      const retryDelay = NEON_CONNECTION_ATTEMPT_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined || !isNeonConnectionAttemptExhaustion(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

function isNeonConnectionAttemptExhaustion(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "XX000" &&
    error.message === "Too many connections attempts"
  );
}

export function derivePreviewDatabasePassword(
  credentialKey: string,
  projectId: string,
  productionBranchId: string,
  previewBranchName: string,
  owner: string,
): string {
  if (Buffer.byteLength(credentialKey, "utf8") < 32) {
    throw new Error("Preview database credential key must contain at least 32 bytes");
  }
  return createHmac("sha256", credentialKey)
    .update(`${projectId}\0${productionBranchId}\0${previewBranchName}\0${owner}`)
    .digest("base64url");
}

export function serviceConnectionUrl(
  adminConnection: string,
  spec: DeploymentDatabaseSpec,
  password: string,
): string {
  if (password.length < 32) {
    throw new Error(`database password is missing or too short for ${spec.owner}`);
  }
  const url = new URL(adminConnection);
  url.username = spec.role;
  url.password = password;
  url.pathname = `/${spec.database}`;
  url.searchParams.set("sslmode", "verify-full");
  return assertConnectionUrl(url.toString(), spec).toString();
}

function neonSuperuserRevocationStatement(role: string): string {
  const roleLiteral = quoteLiteral(role);
  const roleIdentifier = quoteIdentifier(role);
  // PostgreSQL checks the grantor's ADMIN option even when REVOKE would be a no-op.
  // Keep an existing membership fail-closed, but avoid requiring ADMIN after it is already absent.
  return `DO $role_membership$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = 'neon_superuser'
      AND member_role.rolname = ${roleLiteral}
  ) THEN
    REVOKE "neon_superuser" FROM ${roleIdentifier};
  END IF;
END;
$role_membership$`;
}

export function databaseEnvironmentName(owner: string, source: "direct" | "pooled"): string {
  if (!OWNER_PATTERN.test(owner)) {
    throw new Error(`deployment database owner is invalid: ${owner}`);
  }
  const prefix = owner.replaceAll("-", "_").toUpperCase();
  return `PLATFORM_PREVIEW_${prefix}_DATABASE_URL${source === "direct" ? "_UNPOOLED" : ""}`;
}

export function assertConnectionUrl(
  value: string,
  spec: DeploymentDatabaseSpec,
  branchHost?: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Neon returned an invalid connection URI for ${spec.owner}`);
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.pathname !== `/${spec.database}` ||
    decodeURIComponent(parsed.username) !== spec.role
  ) {
    throw new Error(`Neon connection URI for ${spec.owner} must use ${spec.role}/${spec.database}`);
  }
  if (branchHost && normalizeNeonHost(parsed.hostname) !== normalizeNeonHost(branchHost)) {
    throw new Error(`Neon connection URI for ${spec.owner} belongs to another branch endpoint`);
  }
  parsed.searchParams.set("sslmode", "verify-full");
  return parsed;
}

export function assertDistinctServiceConnections(
  connections: ReadonlyMap<string, { direct: string; pooled: string }>,
  specs: readonly DeploymentDatabaseSpec[],
): void {
  if (connections.size !== specs.length) {
    throw new Error("deployment database connections are incomplete");
  }
  const directIdentities = new Set<string>();
  let branchHost: string | undefined;
  for (const spec of specs) {
    const connection = connections.get(spec.owner);
    if (!connection) throw new Error(`deployment database connection is missing: ${spec.owner}`);
    const direct = assertConnectionUrl(connection.direct, spec, branchHost);
    branchHost ??= direct.hostname;
    const pooled = assertConnectionUrl(connection.pooled, spec, direct.hostname);
    const identity = `${normalizeNeonHost(direct.hostname)}${direct.pathname}`;
    if (directIdentities.has(identity)) {
      throw new Error("deployment services must not share a database identity");
    }
    directIdentities.add(identity);
    if (
      connection.direct.includes(connection.pooled) ||
      connection.pooled.includes(connection.direct)
    ) {
      throw new Error("deployment pooled and direct connections must be distinct");
    }
  }
}

export async function verifyDatabaseIsolation(input: {
  connections: ReadonlyMap<string, { direct: string; pooled: string }>;
  probe: (
    connection: string,
  ) => Promise<{ database: string; neonSuperuser: boolean; role: string }>;
  specs: readonly DeploymentDatabaseSpec[];
}): Promise<void> {
  for (const spec of input.specs) {
    const connection = input.connections.get(spec.owner);
    if (!connection) throw new Error(`deployment database connection is missing: ${spec.owner}`);
    const identity = await input.probe(connection.direct);
    if (
      identity.database !== spec.database ||
      identity.role !== spec.role ||
      identity.neonSuperuser
    ) {
      throw new Error(
        `database isolation verification failed for ${spec.owner}: expected ${spec.role}/${spec.database} without neon_superuser`,
      );
    }
    for (const foreign of input.specs.filter(({ owner }) => owner !== spec.owner)) {
      const crossDatabase = new URL(connection.direct);
      crossDatabase.pathname = `/${foreign.database}`;
      try {
        await input.probe(crossDatabase.toString());
      } catch (error) {
        if (error instanceof DatabaseConnectDeniedError) continue;
        throw error;
      }
      throw new Error(`${spec.owner} can connect to foreign database ${foreign.database}`);
    }
  }
}

export async function provisionBranchDatabases(input: {
  api: NeonApi;
  branch: NeonBranch;
  connectionUri: DatabaseConnectionFactory;
  projectId: string;
  specs: readonly DeploymentDatabaseSpec[];
  runAdminStatements: (statements: readonly string[]) => Promise<void>;
}): Promise<ReadonlyMap<string, { direct: string; pooled: string }>> {
  const { api, branch, projectId, specs } = input;
  const base = `/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}`;
  let roles = parseRoles(await api(`${base}/roles`));
  let databases = parseDatabases(await api(`${base}/databases`));
  validateDatabaseOwnership(branch.id, specs, databases, roles);
  const missingRoles = specs.filter((spec) => !roles.some(({ name }) => name === spec.role));
  const missingDatabases = specs.filter(
    (spec) => !databases.some(({ name }) => name === spec.database),
  );
  if (missingRoles.length > 0 || missingDatabases.length > 0) {
    throw new Error(
      `database environment is not initialized: missing ${[
        ...missingRoles.map(({ role }) => `role ${role}`),
        ...missingDatabases.map(({ database }) => `database ${database}`),
      ].join(", ")}`,
    );
  }

  await input.runAdminStatements(
    databaseAccessStatements(
      specs,
      databases.map(({ name }) => name),
    ),
  );

  const connections = new Map<string, { direct: string; pooled: string }>();
  for (const spec of specs) {
    const direct = assertConnectionUrl(await input.connectionUri(spec, false), spec).toString();
    const pooled = assertConnectionUrl(await input.connectionUri(spec, true), spec).toString();
    connections.set(spec.owner, { direct, pooled });
  }
  assertDistinctServiceConnections(connections, specs);
  return connections;
}

export async function waitForNeonOperations(
  api: NeonApi,
  projectId: string,
  mutationResponse: unknown,
): Promise<void> {
  const operations = parseOperations(mutationResponse);
  for (const operation of operations) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await api(
        `/projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operation.id)}`,
      );
      if (!isRecord(response) || !isOperation(response.operation)) {
        throw new Error("Neon returned an invalid operation response");
      }
      if (response.operation.status === "finished") break;
      if (response.operation.status === "failed" || response.operation.status === "cancelled") {
        throw new Error(`Neon operation ${operation.id} ${response.operation.status}`);
      }
      if (attempt === 119) throw new Error(`timed out waiting for Neon operation ${operation.id}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function parseRoles(value: unknown): readonly NeonRole[] {
  if (!isRecord(value) || !Array.isArray(value.roles) || !value.roles.every(isRole)) {
    throw new Error("Neon returned an invalid role response");
  }
  return value.roles;
}

function parseDatabases(value: unknown): readonly NeonDatabase[] {
  if (!isRecord(value) || !Array.isArray(value.databases) || !value.databases.every(isDatabase)) {
    throw new Error("Neon returned an invalid database response");
  }
  return value.databases;
}

function parseOperations(value: unknown): readonly NeonOperation[] {
  if (!isRecord(value)) throw new Error("Neon returned an invalid mutation response");
  const operations = Array.isArray(value.operations)
    ? value.operations
    : isOperation(value.operation)
      ? [value.operation]
      : [];
  if (!operations.every(isOperation)) {
    throw new Error("Neon returned an invalid operation list");
  }
  return operations;
}

function isRole(value: unknown): value is NeonRole {
  return isRecord(value) && typeof value.branch_id === "string" && typeof value.name === "string";
}

function isDatabase(value: unknown): value is NeonDatabase {
  return (
    isRecord(value) &&
    typeof value.branch_id === "string" &&
    typeof value.name === "string" &&
    typeof value.owner_name === "string"
  );
}

function isOperation(value: unknown): value is NeonOperation {
  return isRecord(value) && typeof value.id === "string" && typeof value.status === "string";
}

function normalizeNeonHost(hostname: string): string {
  return hostname.replace("-pooler.", ".").toLowerCase();
}

function isNeonStartupConnectionError(error: unknown): boolean {
  return (
    isRecord(error) && error.code === "XX000" && error.message === "Too many connections attempts"
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
