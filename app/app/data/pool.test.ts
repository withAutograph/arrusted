import { createConnection, createServer, type Server } from "node:net";
import { afterEach, expect, test, vi } from "vite-plus/test";

vi.mock("server-only", () => ({}));
const { ResilientPool } = await import("./pool");

const databaseUrl = process.env.KERNEL_TEST_DATABASE_URL;
const pgSuite = databaseUrl ? test : test.skip;
const target = new URL(databaseUrl ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres");
let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A proxy that drops the first `drops` connections the way a waking database can. */
async function flakyProxy(drops: number) {
  let seen = 0;
  server = createServer((socket) => {
    seen += 1;
    if (seen <= drops) {
      socket.destroy();
      return;
    }
    const upstream = createConnection(Number(target.port || 5432), target.hostname);
    socket.pipe(upstream).pipe(socket);
    const close = () => (socket.destroy(), upstream.destroy());
    socket.on("error", close);
    upstream.on("error", close);
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const port = (server!.address() as { port: number }).port;
  return {
    url: (password = decodeURIComponent(target.password)) => {
      const next = new URL(target.toString());
      next.hostname = "127.0.0.1";
      next.port = String(port);
      if (password || target.password) next.password = password;
      return next.toString();
    },
    seen: () => seen,
  };
}

pgSuite(
  "retries connections dropped before any query ran on both connect() and query()",
  async () => {
    const proxy = await flakyProxy(2);
    const pool = new ResilientPool({ connectionString: proxy.url(), max: 1 });
    try {
      const client = await pool.connect();
      expect((await client.query("select 1 as ok")).rows[0].ok).toBe(1);
      client.release();
      expect(proxy.seen()).toBe(3);
    } finally {
      await pool.end();
    }

    await new Promise<void>((done) => server!.close(() => done()));
    server = undefined;

    const queryProxy = await flakyProxy(2);
    const queryPool = new ResilientPool({ connectionString: queryProxy.url(), max: 1 });
    try {
      expect((await queryPool.query("select 2 as ok")).rows[0].ok).toBe(2);
      expect(queryProxy.seen()).toBe(3);
    } finally {
      await queryPool.end();
    }
  },
);

test("does not retry a non-transient error", async () => {
  let seen = 0;
  server = createServer((socket) => {
    seen += 1;
    // Send valid Postgres ErrorResponse (FATAL 28P01 invalid_password)
    const msg = Buffer.from("SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed\0\0", "utf8");
    const frame = Buffer.alloc(5 + msg.length);
    frame[0] = 0x45; // 'E'
    frame.writeInt32BE(4 + msg.length, 1);
    msg.copy(frame, 5);
    socket.once("data", () => {
      socket.write(frame, () => socket.end());
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const port = (server!.address() as { port: number }).port;
  const pool = new ResilientPool({
    connectionString: `postgres://user:wrong@127.0.0.1:${port}/postgres?sslmode=disable`,
    max: 1,
  });
  try {
    await expect(pool.connect()).rejects.toThrow(/password/i);
    expect(seen).toBe(1);
  } finally {
    await pool.end();
  }
});

test("rejects unsafe searchPath identifiers", () => {
  expect(
    () =>
      new ResilientPool({
        connectionString: "postgres://user:pass@127.0.0.1:5432/postgres?sslmode=disable",
        searchPath: "auth_crm; drop schema public",
      }),
  ).toThrow(/searchPath/i);
});

pgSuite(
  "scopes searchPath transaction-locally so PgBouncer transaction multiplexing neither loses auth_* nor leaks search_path",
  async () => {
    const { Client } = await import("pg");
    const setupClient = new Client({ connectionString: databaseUrl });
    await setupClient.connect();
    const testSchema = `auth_pool_tx_${process.pid}_${Date.now()}`;
    try {
      await setupClient.query(`create schema "${testSchema}"`);
      await setupClient.query(
        `create table "${testSchema}"."session_probe" ("id" text primary key, "label" text not null)`,
      );

      // Simulate PgBouncer pool_mode=transaction: two backend connections multiplexed per transaction,
      // resetting session search_path whenever a transaction ends.
      const backendA = new Client({ connectionString: databaseUrl });
      const backendB = new Client({ connectionString: databaseUrl });
      await backendA.connect();
      await backendB.connect();
      try {
        let rr = 0;
        let pinned: InstanceType<typeof Client> | undefined;
        let resets = 0;

        const fakePgBouncerClient = {
          query: async (sql: string, values?: unknown[]) => {
            const trimmed = sql.trimStart();
            if (/^(?:begin|start\s+transaction)\b/iu.test(trimmed)) {
              pinned = rr++ % 2 === 0 ? backendA : backendB;
              return await pinned.query(sql, values);
            }
            if (
              /^(?:commit|end|rollback)\b/iu.test(trimmed) &&
              !/^rollback\s+to\b/iu.test(trimmed)
            ) {
              const targetBackend = pinned ?? backendA;
              pinned = undefined;
              const res = await targetBackend.query(sql, values);
              await targetBackend.query("reset search_path");
              resets += 1;
              return res;
            }
            const targetBackend = pinned ?? (rr++ % 2 === 0 ? backendA : backendB);
            const res = await targetBackend.query(sql, values);
            if (!pinned) {
              await targetBackend.query("reset search_path");
              resets += 1;
            }
            return res;
          },
          release: () => {},
          on: () => fakePgBouncerClient,
          once: () => fakePgBouncerClient,
          removeListener: () => fakePgBouncerClient,
        };

        const muxPool = new ResilientPool({
          connectionString: databaseUrl,
          searchPath: testSchema,
          max: 1,
        });
        const baseProto = Object.getPrototypeOf(ResilientPool.prototype) as {
          connect: (this: unknown, ...args: unknown[]) => Promise<unknown>;
        };
        const origSuperConnect = baseProto.connect;
        const connectSpy = vi.spyOn(baseProto, "connect").mockImplementation(function (
          this: unknown,
          ...args: unknown[]
        ) {
          if (this === muxPool) {
            return Promise.resolve(fakePgBouncerClient);
          }
          return origSuperConnect.apply(this, args);
        });
        try {
          for (let i = 0; i < 6; i++) {
            await muxPool.query('insert into "session_probe" ("id", "label") values ($1, $2)', [
              `mux-${i}`,
              `val-${i}`,
            ]);
            const got = await muxPool.query<{ label: string }>(
              'select "label" from "session_probe" where "id" = $1',
              [`mux-${i}`],
            );
            expect(got.rows[0]?.label).toBe(`val-${i}`);
          }
          expect(resets).toBeGreaterThanOrEqual(12);
          expect(
            (await backendA.query<{ search_path: string }>("show search_path")).rows[0]
              ?.search_path,
          ).not.toContain(testSchema);
          expect(
            (await backendB.query<{ search_path: string }>("show search_path")).rows[0]
              ?.search_path,
          ).not.toContain(testSchema);
        } finally {
          connectSpy.mockRestore();
          await muxPool.end();
        }

        // Also test direct ResilientPool against live PG (standalone pool.query/client.query and explicit BEGIN/COMMIT),
        // verifying session search_path on the underlying connection remains untouched after each call!
        const scopedPool = new ResilientPool({
          connectionString: databaseUrl,
          searchPath: testSchema,
          max: 1,
        });
        try {
          await scopedPool.query('insert into "session_probe" ("id", "label") values ($1, $2)', [
            "row-1",
            "standalone-pool-query",
          ]);
          const got1 = await scopedPool.query<{ label: string }>(
            'select "label" from "session_probe" where "id" = $1',
            ["row-1"],
          );
          expect(got1.rows[0]?.label).toBe("standalone-pool-query");

          // Explicit caller transaction (Kysely style: BEGIN -> queries -> COMMIT)
          const checkedOut = await scopedPool.connect();
          try {
            await checkedOut.query("begin");
            await checkedOut.query('insert into "session_probe" ("id", "label") values ($1, $2)', [
              "row-2",
              "explicit-tx",
            ]);
            const insideTx = await checkedOut.query<{ current_schema: string }>(
              "select current_schema() as current_schema",
            );
            expect(insideTx.rows[0]?.current_schema).toBe(testSchema);
            await checkedOut.query("commit");
          } finally {
            checkedOut.release();
          }

          // Inspect raw underlying pg.Pool connection: session-level search_path was NEVER mutated to testSchema!
          const rawUnderlying = await PoolPrototypeConnect().call(scopedPool);
          try {
            const rawPath = await rawUnderlying.query<{ search_path: string }>("show search_path");
            expect(rawPath.rows[0]?.search_path).not.toContain(testSchema);
          } finally {
            rawUnderlying.release();
          }
        } finally {
          await scopedPool.end();
        }
      } finally {
        await backendA.end();
        await backendB.end();
      }
    } finally {
      await setupClient.query(`drop schema if exists "${testSchema}" cascade`);
      await setupClient.end();
    }
  },
);

function PoolPrototypeConnect() {
  return Object.getPrototypeOf(ResilientPool.prototype).connect as () => Promise<{
    query: <T>(sql: string) => Promise<{ rows: T[] }>;
    release: () => void;
  }>;
}
