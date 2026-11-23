import type { BetterAuthOptions } from "better-auth";

import type { AuthEnvironmentSource } from "./env";
import { createAuthEmailSender } from "./email-delivery";

type EmailPasswordOptions = NonNullable<BetterAuthOptions["emailAndPassword"]>;

/** A sending-only credential never enables the Infrastructure dashboard. */
export function createPasswordRecoveryOptions(
  source: AuthEnvironmentSource,
  appName: string,
): Pick<EmailPasswordOptions, "sendResetPassword" | "revokeSessionsOnPasswordReset"> | undefined {
  const send = createAuthEmailSender(source);
  if (!send) return undefined;
  return {
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      try {
        await send({
          to: user.email,
          subject: `Reset your ${appName} password`,
          text: [
            `A password reset was requested for your ${appName} account.`,
            "Reset your password:",
            url,
            "This link can only be used once. If you did not request a reset, ignore this email.",
          ].join("\n\n"),
        });
        return;
      } catch {
        // Delivery errors can contain credentials, recipients or reset links.
      }
      throw new Error("auth_password_recovery_delivery_unavailable");
    },
  };
}
