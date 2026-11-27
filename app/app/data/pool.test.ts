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
