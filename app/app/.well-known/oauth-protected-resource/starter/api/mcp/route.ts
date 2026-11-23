import { connection } from "next/server";
import { agentResourceMetadata } from "@autograph/auth/agent-grant-policy";
import { appId, requiredEnv } from "../../../../../data/auth";
export async function GET() {
  await connection();
  return Response.json(agentResourceMetadata(requiredEnv("BETTER_AUTH_URL"), appId));
}
