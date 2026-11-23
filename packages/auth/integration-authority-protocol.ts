import { createHmac, timingSafeEqual } from "node:crypto";

export const INTEGRATION_AUTHORITY_PATH = "/api/auth/platform/integration-activation-authority";
type Authority = { actorId: string; organizationId: string; appId: string };

function validAuthority(value: unknown): value is Authority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).length === 3 &&
    [entry.actorId, entry.organizationId, entry.appId].every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256,
    )
  );
}

function signature(body: string, time: string, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(
      JSON.stringify(["integration-authority-v1", "POST", INTEGRATION_AUTHORITY_PATH, time, body]),
    )
    .digest();
}

/** A separate secret is held only by the Auth host and central Integrations service. */
export function signIntegrationAuthority(input: Authority, secret: string, now = Date.now()) {
  if (!validAuthority(input) || secret.length < 32) throw new Error("invalid_authority_request");
  const body = JSON.stringify(input);
  const time = String(now);
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-integration-authority-time": time,
      "x-integration-authority-signature": signature(body, time, secret).toString("base64url"),
    },
  };
}

export function verifyIntegrationAuthority(
  body: string,
  headers: Headers,
  secret: string,
  now = Date.now(),
): Authority | null {
  const time = headers.get("x-integration-authority-time") ?? "";
  const supplied = headers.get("x-integration-authority-signature") ?? "";
  if (
    secret.length < 32 ||
    body.length > 4096 ||
    !/^\d{13}$/.test(time) ||
    Math.abs(now - Number(time)) > 60_000 ||
    !/^[A-Za-z0-9_-]{43}$/.test(supplied)
  )
    return null;
  const expected = signature(body, time, secret);
  const actual = Buffer.from(supplied, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value: unknown = JSON.parse(body);
    return validAuthority(value) ? value : null;
  } catch {
    return null;
  }
}
