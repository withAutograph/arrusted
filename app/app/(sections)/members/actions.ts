"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { errorMessage, redact } from "@autograph/auth/redact";
import { getIdentity } from "../../data/auth";

const safeActionMessages = new Set([
  "Sign in to continue.",
  "Only an owner can manage members.",
  "Enter a valid email.",
  "Member no longer exists.",
  "Cannot remove the last owner.",
]);

function actionError(error: unknown, fallback: string): string {
  if (error instanceof Error && safeActionMessages.has(error.message)) return error.message;
  console.error(redact(`Members action failed: ${errorMessage(error)}`));
  return fallback;
}

export async function invite(email: string): Promise<{ link?: string; error?: string }> {
  try {
    const link = await getIdentity().invite(await headers(), email);
    revalidatePath("/members");
    return { link };
  } catch (error) {
    return { error: actionError(error, "Could not create invitation.") };
  }
}

export async function revoke(id: string): Promise<{ error?: string }> {
  try {
    await getIdentity().revoke(await headers(), id);
    revalidatePath("/members");
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not revoke invitation.") };
  }
}

export async function promoteMember(userId: string): Promise<{ error?: string }> {
  try {
    await getIdentity().changeMember(await headers(), userId, "promote");
    revalidatePath("/members");
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not promote member.") };
  }
}

export async function removeMember(userId: string): Promise<{ error?: string }> {
  try {
    await getIdentity().changeMember(await headers(), userId, "remove");
    revalidatePath("/members");
    return {};
  } catch (error) {
    return { error: actionError(error, "Could not remove member.") };
  }
}
