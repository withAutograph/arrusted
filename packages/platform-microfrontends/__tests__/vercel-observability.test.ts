import { describe, expect, it } from "vitest";

import {
  serializeVercelOperationalEvent,
  vercelOperationalDeploymentContext,
} from "../src/hosting/vercel/observability";

const base = {
  schemaVersion: 1 as const,
  event: "vercel_operational_event" as const,
  severity: "error" as const,
  project: "apps",
  service: "hc",
  environment: "preview" as const,
  category: "app-smoke-failure",
  failureClass: "app-smoke-workflow-failed",
  routeCategory: "hc",
  requestId: "00000000-0000-4000-8000-000000000001",
  status: 503,
};

describe("sanitized Vercel operational receipts", () => {
  it("copies only allowlisted fields and ignores inherited toJSON", () => {
    const input = Object.create({ toJSON: () => ({ token: "secret" }) }) as typeof base & {
      durationMs?: number;
    };
    Object.assign(input, base, { durationMs: 42 });
    const receipt = JSON.parse(serializeVercelOperationalEvent(input));
    expect(receipt).toEqual({ ...base, durationMs: 42 });
    expect(JSON.stringify(receipt)).not.toContain("token");
  });

  it("rejects unknown or malformed sensitive correlation fields", () => {
    expect(() => serializeVercelOperationalEvent({ ...base, body: "private" } as never)).toThrow(
      "not allowlisted",
    );
    expect(() =>
      serializeVercelOperationalEvent({ ...base, requestId: "not-a-request-id" }),
    ).toThrow("requestId");
  });

  it("keeps only deployment and commit identity from the environment", () => {
    expect(
      vercelOperationalDeploymentContext({
        VERCEL_DEPLOYMENT_ID: "dpl_preview1",
        VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
        PRIVATE_ORIGIN: "https://private.invalid",
      }),
    ).toEqual({ deploymentId: "dpl_preview1", sourceSha: "a".repeat(40) });
  });
});
