"use client";

import {
  authMutationKeys,
  getProviderId,
  getProviderName,
  type AuthSocialProvider,
  type AuthView,
} from "@better-auth-ui/core";
import { providerIcons, useAuth, useSignInSocial } from "@better-auth-ui/react";
import { useIsMutating } from "@tanstack/react-query";
import type { ComponentProps } from "react";

import { Button } from "#components/ui/button";
import { Spinner } from "#components/ui/spinner";
import { cn } from "#lib/utils";
import { LastUsedBadge } from "./last-login-method/last-used-badge";

export type ProviderButtonProps = {
  provider: AuthSocialProvider;
  display?: "full" | "name" | "icon";
  view?: AuthView;
} & Omit<ComponentProps<typeof Button>, "onClick" | "children" | "disabled">;

/**
 * Social provider sign-in button.
 *
 * @param provider - Provider to sign in with.
 * @param display - `"full"` (e.g. "Continue with Google"), `"name"` (just the provider name), or `"icon"` (icon only).
 */
export function ProviderButton({
  provider,
  display = "full",
  view = "signIn",
  variant = "outline",
  className,
  ...props
}: ProviderButtonProps) {
  const { authClient, baseURL, localization, redirectTo } = useAuth();
  const providerId = getProviderId(provider);

  const callbackURL = `${baseURL}${redirectTo}`;

  const { mutate: signInSocial, isPending: signInSocialPending } = useSignInSocial(authClient);

  const ProviderIcon = providerIcons[providerId];

  const signInMutating = useIsMutating({
    mutationKey: authMutationKeys.signIn.all,
  });
  const signUpMutating = useIsMutating({
    mutationKey: authMutationKeys.signUp.all,
  });
  const isPending = signInMutating + signUpMutating > 0;

  const handleSignIn = () => {
    signInSocial({
      provider: providerId,
      callbackURL,
      errorCallbackURL: currentAuthErrorCallbackURL(),
    });
  };

  return (
    <Button
      type="button"
      variant={variant}
      disabled={isPending}
      onClick={handleSignIn}
      className={cn("relative overflow-visible", className)}
      {...props}
    >
      {signInSocialPending ? <Spinner /> : ProviderIcon ? <ProviderIcon /> : null}

      {display === "full"
        ? localization.auth.continueWith.replace("{{provider}}", getProviderName(provider))
        : display === "name"
          ? getProviderName(provider)
          : null}

      {display === "icon" && <span className="sr-only">{getProviderName(provider)}</span>}

      {view !== "signUp" && <LastUsedBadge method={providerId} floating />}
    </Button>
  );
}

export function currentAuthErrorCallbackURL(locationHref = window.location.href) {
  const errorCallbackURL = new URL(locationHref);
  errorCallbackURL.searchParams.delete("error");
  errorCallbackURL.searchParams.delete("error_description");
  return errorCallbackURL.href;
}
