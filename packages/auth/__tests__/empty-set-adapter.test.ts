import { memoryAdapter } from "@better-auth/memory-adapter";
import { betterAuth, type BetterAuthOptions, type DBAdapter } from "better-auth";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

import { emptySetAdapter } from "../empty-set-adapter";

type ReadInput = Parameters<DBAdapter["findMany"]>[0];
const unsupportedEmptySet = new Error("Controlled adapter rejects empty IN");
const delegatedFailure = new Error("Controlled independent adapter failure");

function fixture(repair = true) {
  const records: Record<string, Record<string, unknown>[]> = {
    account: [],
    session: [],
    user: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const calls: ReadInput[] = [];
  let fail = false;
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "controlled-empty-set-fixture-secret-32-bytes",
    emailAndPassword: { enabled: true },
    database: (options: BetterAuthOptions) => {
      const adapter = memoryAdapter(records)(options);
      const findMany = adapter.findMany.bind(adapter);
      adapter.findMany = async <T>(input: ReadInput): Promise<T[]> => {
        calls.push(input);
        if (fail) throw delegatedFailure;
        if (
          input.where?.length === 1 &&
          input.where[0]?.operator === "in" &&
          Array.isArray(input.where[0].value) &&
          input.where[0].value.length === 0
        ) {
          throw unsupportedEmptySet;
        }
        return findMany<T>(input);
      };
      return adapter;
    },
    plugins: [...(repair ? [emptySetAdapter()] : []), organization()],
  });
  return {
    auth,
    records,
    calls,
    rejectReads: () => {
      fail = true;
    },
  };
}

async function owner(f: ReturnType<typeof fixture>) {
  const signedUp = await f.auth.handler(
    new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "owner@example.test",
        name: "Owner",
        password: "controlled-password",
      }),
    }),
  );
  expect(signedUp.status).toBe(200);
  const signedUpBody = (await signedUp.json()) as { user: { id: string } };
  const cookie = signedUp.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const created = await f.auth.handler(
    new Request("http://localhost:3000/api/auth/organization/create", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie },
      body: JSON.stringify({ name: "Owned organization", slug: "owned-organization" }),
    }),
  );
  expect(created.status).toBe(200);
  const body = (await created.json()) as { id: string };
  return { cookie, organizationId: body.id, userId: signedUpBody.user.id };
}

function list(
  f: ReturnType<typeof fixture>,
  scope: { cookie?: string; organizationId: string },
  extra: Record<string, string> = {},
) {
  const query = new URLSearchParams({ organizationId: scope.organizationId, ...extra });
  return f.auth.handler(
    new Request(`http://localhost:3000/api/auth/organization/list-members?${query}`, {
      headers: scope.cookie === undefined ? {} : { cookie: scope.cookie },
    }),
  );
}

describe("Auth adapter empty-set reads", () => {
  it("reproduces the unsupported empty IN through the real organization route without the repair", async () => {
    const f = fixture(false);
    const scope = await owner(f);
    const response = await list(f, scope, {
      filterField: "userId",
      filterOperator: "eq",
      filterValue: "not-yet-a-member",
    });
    expect(response.status).toBe(500);
    expect(
      f.calls.some(
        (call) =>
          call.where?.[0]?.operator === "in" &&
          Array.isArray(call.where[0].value) &&
          call.where[0].value.length === 0,
      ),
    ).toBe(true);
  });

  it("returns an honest empty filtered membership result and preserves nonempty member reads", async () => {
    const f = fixture();
    const scope = await owner(f);
    const missing = await list(f, scope, {
      filterField: "userId",
      filterOperator: "eq",
      filterValue: "not-yet-a-member",
    });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ members: [], total: 0 });
    const present = await list(f, scope, {
      filterField: "userId",
      filterOperator: "eq",
      filterValue: scope.userId,
    });
    expect(present.status).toBe(200);
    expect(await present.json()).toMatchObject({
      members: [
        { userId: scope.userId, organizationId: scope.organizationId, user: { id: scope.userId } },
      ],
      total: 1,
    });
    expect(
      f.calls.some(
        (call) =>
          call.where?.[0]?.operator === "in" &&
          Array.isArray(call.where[0].value) &&
          call.where[0].value.length === 0,
      ),
    ).toBe(false);
  });

  it("preserves the original count for an empty page instead of treating unknown or total as zero", async () => {
    const f = fixture();
    const scope = await owner(f);
    const response = await list(f, scope, { offset: "25", limit: "10" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ members: [], total: 1 });
  });

  it("preserves normal session and requested-organization membership checks", async () => {
    const f = fixture();
    const scope = await owner(f);
    const anonymous = await list(f, { organizationId: scope.organizationId });
    expect(anonymous.status).toBe(401);
    f.records.organization?.push({
      id: "foreign-organization",
      name: "Foreign",
      slug: "foreign",
      createdAt: new Date(),
    });
    const foreign = await list(
      f,
      { ...scope, organizationId: "foreign-organization" },
      { filterField: "userId", filterOperator: "eq", filterValue: "missing" },
    );
    expect(foreign.status).toBe(403);
  });

  it("delegates every other predicate unchanged and preserves independent failures", async () => {
    const f = fixture();
    const adapter = (await f.auth.$context).adapter;
    const empty: ReadInput = { model: "user", where: [{ field: "id", operator: "in", value: [] }] };
    await expect(adapter.findMany(empty)).resolves.toEqual([]);
    expect(f.calls).toEqual([]);
    const queries: ReadInput[] = [
      { model: "user" },
      { model: "user", where: [] },
      { model: "user", where: [{ field: "id", operator: "in", value: ["present"] }] },
      { model: "user", where: [{ field: "id", operator: "not_in", value: [] }] },
      {
        model: "user",
        where: [
          { field: "id", operator: "in", value: [] },
          { field: "name", value: "Owner", connector: "OR" },
        ],
      },
      { model: "user", where: [{ field: "id", value: [] }] },
    ];
    for (const query of queries) {
      await adapter.findMany(query);
      expect(f.calls.at(-1)).toBe(query);
    }
    f.rejectReads();
    await expect(adapter.findMany({ model: "user" })).rejects.toBe(delegatedFailure);
  });
});
