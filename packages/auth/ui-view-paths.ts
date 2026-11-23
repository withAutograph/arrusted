import { getSafeRedirectTo, viewPaths as betterAuthUiViewPaths } from "@better-auth-ui/core";
import type { AuthProviderProps } from "@better-auth-ui/react";

type AuthUiViewPaths = NonNullable<AuthProviderProps["viewPaths"]>;

const DEFAULT_ALLOW_PUBLIC_SIGN_UP = false;

export function createAuthViewPaths({
  allowPublicSignUp = DEFAULT_ALLOW_PUBLIC_SIGN_UP,
  allowPasswordRecovery = false,
}: {
  allowPublicSignUp?: boolean;
  allowPasswordRecovery?: boolean;
} = {}): AuthUiViewPaths {
  return {
    ...betterAuthUiViewPaths,
    auth: {
      ...betterAuthUiViewPaths.auth,
      forgotPassword: allowPasswordRecovery
        ? betterAuthUiViewPaths.auth.forgotPassword
        : betterAuthUiViewPaths.auth.signIn,
      resetPassword: allowPasswordRecovery
        ? betterAuthUiViewPaths.auth.resetPassword
        : betterAuthUiViewPaths.auth.signIn,
      resetLinkSent: allowPasswordRecovery
        ? betterAuthUiViewPaths.auth.resetLinkSent
        : betterAuthUiViewPaths.auth.signIn,
      signUp: allowPublicSignUp
        ? betterAuthUiViewPaths.auth.signUp
        : betterAuthUiViewPaths.auth.signIn,
    },
  };
}

const DEFAULT_AUTH_VIEW_PATHS = createAuthViewPaths().auth!;

export const AUTH_SIGN_IN_VIEW_PATH = DEFAULT_AUTH_VIEW_PATHS.signIn!;

/** Relative return paths need no browser origin during server rendering. */
export function getSafeAuthReturnPath(value: string | null | undefined, origin?: string): string {
  if (origin) return getSafeRedirectTo(value, origin);
  if (!value?.trim().startsWith("/")) return "/";
  // Resolution only: never use this sentinel as an Auth provider or callback origin.
  return getSafeRedirectTo(value, "https://auth.invalid");
}
