import { Pool, type PoolClient, type PoolConfig } from "pg";

// Neon pauses an idle database. The first connections after a pause, or ones the
// server closed while idle, can fail before any query runs; retrying those is safe
// because nothing has been sent yet.
const transient =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|secure TLS connection|timeout exceeded when trying to connect/i;
const attempts = 4;
export const validSearchPath = /^(?:public|auth_[a-z0-9_]{1,57})$/;

export type ResilientPoolConfig = PoolConfig & {
  /**
   * Optional PostgreSQL schema prepended before pg_catalog inside each transaction
   * (`set_config('search_path', ..., true)`), compatible with Neon PgBouncer transaction pooling.
   */
  searchPath?: string;
};

export type WrappedClientEntry = {
  checkout: () => PoolClient;
};

function stripLeadingSqlComments(sql: string): string {
  return sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, "");
}

function splitTopLevelSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const isEscapedString =
        quote === "'" &&
        i > 0 &&
        (sql[i - 1] === "e" || sql[i - 1] === "E") &&
        (i === 1 || !/[A-Za-z0-9_$]/u.test(sql[i - 2]!));
      i += 1;
      while (i < sql.length) {
        if (isEscapedString && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0]!;
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) break;
        i = end + tag.length;
        continue;
      }
    }
    if (ch === ";") {
      const segment = stripLeadingSqlComments(sql.slice(start, i)).trim();
      if (segment.length > 0) statements.push(segment);
      start = i + 1;
    }
    i += 1;
  }
  const tail = stripLeadingSqlComments(sql.slice(start)).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

function isTxControlStatement(stripped: string): boolean {
  return /^(?:begin|start\s+transaction|commit|end|rollback|abort)\b/iu.test(stripped);
}

export function wrapClientForTransactionSearchPath(
  rawClient: PoolClient,
  targetSearchPath: string,
  cache: WeakMap<PoolClient, WrappedClientEntry>,
): PoolClient {
  let existing = cache.get(rawClient);
  if (!existing) {
    let inTx = false;
    let broken = false;
    let pendingCount = 0;
    let queue: Promise<unknown> = Promise.resolve();
    const rawQuery = rawClient.query.bind(rawClient) as (...args: unknown[]) => Promise<unknown>;

    const applyLocalSearchPath = async () => {
      try {
        await rawQuery("select pg_catalog.set_config('search_path', $1, true)", [targetSearchPath]);
      } catch (err) {
        inTx = false;
        await rawQuery("rollback").catch(() => {
          broken = true;
        });
        throw err;
      }
    };

    const executeScoped = async (forwardArgs: unknown[]): Promise<unknown> => {
      const first = forwardArgs[0];
      if (
        first !== null &&
        typeof first === "object" &&
        typeof (first as { submit?: unknown }).submit === "function"
      ) {
        throw new Error(
          "Submittable cursor queries are not supported on a searchPath-scoped pool.",
        );
      }
      const callArgs =
        forwardArgs.length === 2 && forwardArgs[1] === undefined ? [forwardArgs[0]] : forwardArgs;
      const sqlText =
        typeof first === "string"
          ? first
          : first !== null &&
              typeof first === "object" &&
              typeof (first as { text?: unknown }).text === "string"
            ? (first as { text: string }).text
            : "";
      const statements = splitTopLevelSqlStatements(sqlText);
      if (statements.length > 1 && statements.some(isTxControlStatement)) {
        throw new Error(
          "Multi-statement batches containing transaction control are not supported on a searchPath-scoped pool.",
        );
      }
      const stripped = statements[0] ?? stripLeadingSqlComments(sqlText);
      const isBegin = /^(?:begin|start\s+transaction)\b/iu.test(stripped);
      const isCommitOrEnd = /^(?:commit|end)\b/iu.test(stripped);
      const isCommitAndChain = /^(?:commit|end)(?:\s+(?:work|transaction))?\s+and\s+chain\b/iu.test(
        stripped,
      );
      const isSavepointRollback = /^rollback(?:\s+(?:work|transaction))?\s+to\b/iu.test(stripped);
      const isRollbackAndChain =
        !isSavepointRollback &&
        /^(?:rollback|abort)(?:\s+(?:work|transaction))?\s+and\s+chain\b/iu.test(stripped);
      const isFullRollback = /^(?:rollback|abort)\b/iu.test(stripped) && !isSavepointRollback;

      if (isBegin) {
        const res = await rawQuery(...callArgs);
        inTx = true;
        await applyLocalSearchPath();
        return res;
      }

      if (inTx) {
        if (isCommitAndChain || isRollbackAndChain) {
          try {
            const res = await rawQuery(...callArgs);
            inTx = true;
            await applyLocalSearchPath();
            return res;
          } catch (err) {
            broken = true;
            inTx = false;
            throw err;
          }
        }
        if (isCommitOrEnd || isFullRollback) {
          inTx = false;
          try {
            return await rawQuery(...callArgs);
          } catch (err) {
            broken = true;
            throw err;
          }
        }
        return await rawQuery(...callArgs);
      }

      if (isCommitOrEnd || isFullRollback) {
        return await rawQuery(...callArgs);
      }

      await rawQuery("begin");
      try {
        await rawQuery("select pg_catalog.set_config('search_path', $1, true)", [targetSearchPath]);
        const res = await rawQuery(...callArgs);
        await rawQuery("commit");
        return res;
      } catch (err) {
        try {
          await rawQuery("rollback");
        } catch {
          broken = true;
        }
        throw err;
      }
    };

    existing = {
      checkout: () => {
        inTx = false;
        broken = false;
        let checkoutReleased = false;

        const query = (...args: unknown[]) => {
          const last = args[args.length - 1];
          const callback =
            typeof last === "function" &&
            !(args.length === 1 && typeof (last as { submit?: unknown }).submit === "function")
              ? (last as (err: Error | undefined, result?: unknown) => void)
              : undefined;
          const forwardArgs = callback ? args.slice(0, -1) : args;
          if (checkoutReleased) {
            const releasedErr = new Error(
              "Cannot execute query after client has been released to the pool.",
            );
            if (callback) {
              queueMicrotask(() => callback(releasedErr));
              return undefined;
            }
            return Promise.reject(releasedErr);
          }
          pendingCount += 1;
          const run = queue
            .then(
              () => executeScoped(forwardArgs),
              () => executeScoped(forwardArgs),
            )
            .finally(() => {
              pendingCount -= 1;
            });
          queue = run.then(
            () => undefined,
            () => undefined,
          );
          if (callback) {
            run.then(
              (res) => callback(undefined, res),
              (err) => callback(err as Error),
            );
            return undefined;
          }
          return run;
        };

        const release = (err?: boolean | Error) => {
          if (checkoutReleased) return;
          checkoutReleased = true;
          const hasUnsettled = pendingCount > 0;
          const forceDiscard = inTx || broken || hasUnsettled;
          const discard = err instanceof Error ? err : err === true || forceDiscard ? true : err;
          if (hasUnsettled) {
            void queue.finally(() => {
              inTx = false;
              broken = false;
              rawClient.release(discard);
            });
            return;
          }
          inTx = false;
          broken = false;
          rawClient.release(discard);
        };

        return new Proxy(rawClient, {
          get(target, prop) {
            if (prop === "query") return query;
            if (prop === "release") return release;
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    cache.set(rawClient, existing);
  }
  return existing.checkout();
}

export function bindPoolToSearchPath(pool: Pool, searchPath: string | undefined): Pool {
  if (searchPath === undefined) return pool;
  if (!validSearchPath.test(searchPath)) {
    throw new Error(
      "Invalid searchPath: expected 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
    );
  }
  const existing = (pool as { configuredSearchPath?: string }).configuredSearchPath;
  if (existing !== undefined) {
    if (existing !== searchPath) {
      throw new Error(
        `Database pool searchPath ('${existing}') disagrees with authSchema ('${searchPath}').`,
      );
    }
    return pool;
  }
  const wrappedClients = new WeakMap<PoolClient, WrappedClientEntry>();
  const targetSearchPath = `${searchPath}, pg_catalog`;
  const acquire = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    return wrapClientForTransactionSearchPath(client, targetSearchPath, wrappedClients);
  };
  const connect = (
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void => {
    if (callback) {
      acquire().then(
        (client) =>
          callback(undefined, client, (release) =>
            client.release(release as boolean | Error | undefined),
          ),
        (err) => callback(err as Error, undefined, () => {}),
      );
      return;
    }
    return acquire();
  };
  const query = (...args: unknown[]) => {
    const last = args[args.length - 1];
    const callback =
      typeof last === "function" &&
      !(args.length === 1 && typeof (last as { submit?: unknown }).submit === "function")
        ? (last as (err: Error | undefined, result?: unknown) => void)
        : undefined;
    const forwardArgs = callback ? args.slice(0, -1) : args;
    const run = (async () => {
      const client = await acquire();
      let releaseErr: Error | boolean | undefined;
      const onError = (err: Error) => {
        releaseErr = err;
      };
      client.on("error", onError);
      try {
        return await (client.query as (...a: unknown[]) => Promise<unknown>)(...forwardArgs);
      } finally {
        client.removeListener("error", onError);
        client.release(releaseErr);
      }
    })();
    if (callback) {
      run.then(
        (res) => callback(undefined, res),
        (err) => callback(err as Error),
      );
      return undefined;
    }
    return run;
  };
  return new Proxy(pool, {
    get(target, prop) {
      if (prop === "configuredSearchPath") return searchPath;
      if (prop === "connect") return connect;
      if (prop === "query") return query;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class ResilientPool extends Pool {
  readonly configuredSearchPath: string | undefined;
  private readonly wrappedClients = new WeakMap<PoolClient, WrappedClientEntry>();

  constructor(config: ResilientPoolConfig) {
    const { searchPath, ...poolConfig } = config;
    if (searchPath !== undefined && !validSearchPath.test(searchPath)) {
      throw new Error(
        "Invalid searchPath: expected 'public' or an 'auth_<app>' identifier (lowercase alphanumeric/underscore).",
      );
    }
    super({ idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000, ...poolConfig });
    this.configuredSearchPath = searchPath;
    // A dropped idle connection is discarded by the pool; it must not crash the process.
    this.on("error", () => {});
  }

  override connect(): Promise<PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const acquire = async (): Promise<PoolClient> => {
      for (let attempt = 1; ; attempt++) {
        let client: PoolClient | undefined;
        try {
          client = await super.connect();
          return this.configuredSearchPath !== undefined
            ? wrapClientForTransactionSearchPath(
                client,
                `${this.configuredSearchPath}, pg_catalog`,
                this.wrappedClients,
              )
            : client;
        } catch (error) {
          if (client !== undefined) {
            client.release(error instanceof Error ? error : true);
          }
          const detail = `${(error as { code?: string })?.code ?? ""} ${(error as Error)?.message ?? ""}`;
          if (attempt >= attempts || !transient.test(detail)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
      }
    };
    if (callback) {
      acquire().then(
        (client) =>
          callback(undefined, client, (release) =>
            client.release(release as boolean | Error | undefined),
          ),
        (err) => callback(err as Error, undefined, () => {}),
      );
      return;
    }
    return acquire();
  }
}
