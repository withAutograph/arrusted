import { connection } from "next/server";
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getIdentity } from "../../../../data/auth";
export async function GET(request: Request) {
  await connection();
  // The shared plugin factory exposes HTTP endpoints; its return type does not carry inferred API methods.
  return oauthProviderAuthServerMetadata(
    getIdentity().auth as unknown as Parameters<typeof oauthProviderAuthServerMetadata>[0],
  )(request);
}
