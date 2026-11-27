import { Pool, type PoolClient, type PoolConfig } from "pg";

// Neon pauses an idle database. The first connections after a pause, or ones the
// server closed while idle, can fail before any query runs; retrying those is safe
// because nothing has been sent yet.
const transient =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|secure TLS connection|timeout exceeded when trying to connect/i;
const attempts = 4;
const validSearchPath = /^(?:public|auth_[a-z0-9_]{1,57})$/;

export type ResilientPoolConfig = PoolConfig & {
  /**
   * Optional PostgreSQL schema prepended before pg_catalog inside each transaction
   * (`set_config('search_path', ..., true)`), compatible with Neon PgBouncer transaction pooling.
   */
  searchPath?: string;
};

type WrappedClientEntry = {
  proxy: PoolClient;
  reset: () => void;
};

function stripLeadingSqlComments(sql: string): string {
  return sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/gu, "");
}

function wrapClientForTransactionSearchPath(
  rawClient: PoolClient,
  targetSearchPath: string,
  cache: WeakMap<PoolClient, WrappedClientEntry>,
): PoolClient {
  let existing = cache.get(rawClient);
  if (!existing) {
    let inTx = false;
    let broken = false;
    let queue: Promise<unknown> = Promise.resolve();
    const rawQuery = rawClient.query.bind(rawClient) as (...args: unknown[]) => Promise<unknown>;

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
      const stripped = stripLeadingSqlComments(sqlText);
      const isBegin = /^(?:begin|start\s+transaction)\b/iu.test(stripped);
      const isCommitOrEnd = /^(?:commit|end)\b/iu.test(stripped);
      const isFullRollback = /^rollback\b/iu.test(stripped) && !/^rollback\s+to\b/iu.test(stripped);

      if (isBegin) {
        const res = await rawQuery(...callArgs);
        inTx = true;
        try {
          await rawQuery("select pg_catalog.set_config('search_path', $1, true)", [
            targetSearchPath,
          ]);
        } catch (err) {
          inTx = false;
          await rawQuery("rollback").catch(() => {
            broken = true;
          });
          throw err;
        }
        return res;
      }

      if (inTx) {
        if (isCommitOrEnd || isFullRollback) {
          inTx = false;
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

    const query = (...args: unknown[]) => {
      const last = args[args.length - 1];
      const callback =
        typeof last === "function" &&
        !(args.length === 1 && typeof (last as { submit?: unknown }).submit === "function")
          ? (last as (err: Error | undefined, result?: unknown) => void)
          : undefined;
      const forwardArgs = callback ? args.slice(0, -1) : args;
      const run = queue.then(
        () => executeScoped(forwardArgs),
        () => executeScoped(forwardArgs),
      );
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
      const discard = err ?? (inTx || broken ? true : undefined);
      inTx = false;
      broken = false;
      rawClient.release(discard);
    };

    const proxy = new Proxy(rawClient, {
      get(target, prop) {
        if (prop === "query") return query;
        if (prop === "release") return release;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    existing = {
      proxy,
      reset: () => {
        inTx = false;
        broken = false;
      },
    };
    cache.set(rawClient, existing);
  } else {
    existing.reset();
  }
  return existing.proxy;
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
