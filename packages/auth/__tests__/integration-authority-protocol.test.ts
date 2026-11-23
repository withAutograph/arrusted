// @vitest-environment node
import { expect, test } from "vitest";
import {
  signIntegrationAuthority,
  verifyIntegrationAuthority,
} from "../integration-authority-protocol";

test("authenticates the exact authority request and rejects tampering and stale signatures", () => {
  const input = { actorId: "actor", organizationId: "tenant", appId: "vendor" };
  const secret = "fixture-only-secret-at-least-thirty-two-characters";
  const now = 1_800_000_000_000;
  const signed = signIntegrationAuthority(input, secret, now);
  const headers = new Headers(signed.headers);
  expect(verifyIntegrationAuthority(signed.body, headers, secret, now)).toEqual(input);
  expect(
    verifyIntegrationAuthority(signed.body.replace("actor", "other"), headers, secret, now),
  ).toBeNull();
  expect(verifyIntegrationAuthority(signed.body, headers, `${secret}other`, now)).toBeNull();
  expect(verifyIntegrationAuthority(signed.body, headers, secret, now + 60_001)).toBeNull();
  expect(verifyIntegrationAuthority(signed.body, headers, "", now)).toBeNull();
});
