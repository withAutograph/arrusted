import { Resend } from "resend";
import { passwordRecoveryEnabledForEnvironment, type AuthEnvironmentSource } from "./env";

/** The platform sender belongs to this Auth deployment, not to each generated app. */
export function createAuthEmailSender(source: AuthEnvironmentSource) {
  if (!passwordRecoveryEnabledForEnvironment(source)) return undefined;
  const sender = new Resend(source.AUTH_RECOVERY_RESEND_API_KEY!.trim());
  const from = source.AUTH_RECOVERY_EMAIL_FROM!.trim();
  return async (message: { to: string; subject: string; text: string; html?: string }) => {
    try {
      const result = await sender.emails.send({ from, ...message });
      if (!result.error && result.data?.id) return;
    } catch {
      // Provider errors may contain credentials, recipients or authentication links.
    }
    throw new Error("auth_email_delivery_unavailable");
  };
}
