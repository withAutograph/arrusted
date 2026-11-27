import { Pool, type PoolClient, type PoolConfig } from "pg";

// Neon pauses an idle database. The first connections after a pause, or ones the
// server closed while idle, can fail before any query runs; retrying those is safe
// because nothing has been sent yet.
const transient =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|Connection terminated|secure TLS connection|timeout exceeded when trying to connect/i;
const attempts = 4;
const validSearchPath = /^(?:public|auth_[a-z0-9_]{1,57})$/;

export type ResilientPoolConfig = PoolConfig & {
  /** Optional PostgreSQL schema prepended before pg_catalog on every checked-out connection. */
  searchPath?: string;
};

export class ResilientPool extends Pool {
  readonly configuredSearchPath: string | undefined;
  private readonly configured = new WeakSet<object>();

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
          if (this.configuredSearchPath !== undefined && !this.configured.has(client)) {
            const onError = () => {};
            client.on("error", onError);
            try {
              await client.query("select set_config('search_path', $1, false)", [
                `${this.configuredSearchPath}, pg_catalog`,
              ]);
              this.configured.add(client);
            } finally {
              client.removeListener("error", onError);
            }
          }
          return client;
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
