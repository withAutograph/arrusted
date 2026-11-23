"use client";

import type { AuthProviderProps } from "@better-auth-ui/react";
import {
  createElement,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { Toaster as SonnerToaster } from "sonner";

import { AuthProvider } from "./components/auth/auth-provider";
import { authClient } from "./client";
import { mergeAuthUiPlugins } from "./ui-exports";
import { createAuthViewPaths } from "./ui-view-paths";

export type AuthUiNavigate = AuthProviderProps["navigate"];
type AuthUiPlugins = NonNullable<AuthProviderProps["plugins"]>;

export type AuthUiLinkComponent = ComponentType<
  PropsWithChildren<
    { className?: string; href: string; to?: string } & Pick<
      ComponentPropsWithoutRef<"a">,
      "aria-disabled" | "onClick" | "tabIndex"
    >
  >
>;

declare module "@better-auth-ui/core" {
  interface AuthConfig {
    Link: AuthUiLinkComponent;
    /** Installed-policy destination for signup; ordinary sign-in/recovery keep redirectTo. */
    signUpRedirectTo?: string;
  }
}

const EMPTY_AUTH_UI_PLUGINS: AuthUiPlugins = [];
const DEFAULT_SOCIAL_PROVIDERS = [] satisfies NonNullable<AuthProviderProps["socialProviders"]>;
const DEFAULT_EMAIL_AND_PASSWORD = {
  enabled: true,
  forgotPassword: false,
  maxPasswordLength: 128,
  minPasswordLength: 8,
  name: false,
  rememberMe: false,
} satisfies AuthProviderProps["emailAndPassword"];
const RECOVERY_LOCALIZATION = {
  auth: {
    resetLinkSentTo:
      "If an account exists for {{email}}, check its inbox for a password reset link.",
    passwordResetEmailSent:
      "If an account matches that email, check its inbox for a password reset link.",
  },
} satisfies AuthProviderProps["localization"];

function DefaultAuthUiLink({
  children,
  href,
  to,
  ...props
}: {
  children?: ReactNode;
  className?: string;
  href: string;
  to?: string;
}) {
  return createElement("a", { href: to ?? href, ...props }, children);
}

export type AuthUiProviderProps = {
  children: ReactNode;
  Link?: AuthUiLinkComponent;
  navigate: AuthUiNavigate;
  queryClient?: AuthProviderProps["queryClient"];
  redirectTo?: AuthProviderProps["redirectTo"];
  signUpRedirectTo?: string;
  basePaths?: AuthProviderProps["basePaths"];
  baseURL?: AuthProviderProps["baseURL"];
  socialProviders?: AuthProviderProps["socialProviders"];
  plugins?: AuthProviderProps["plugins"];
  emailAndPassword?: AuthProviderProps["emailAndPassword"];
  viewPaths?: AuthProviderProps["viewPaths"];
  allowPasswordRecovery?: boolean;
};

export function AuthUiProvider({
  children,
  Link = DefaultAuthUiLink,
  navigate,
  queryClient,
  redirectTo = "/",
  signUpRedirectTo,
  basePaths,
  baseURL,
  socialProviders = DEFAULT_SOCIAL_PROVIDERS,
  plugins = EMPTY_AUTH_UI_PLUGINS,
  emailAndPassword,
  viewPaths,
  allowPasswordRecovery = false,
}: AuthUiProviderProps) {
  return createElement(
    AuthProvider,
    {
      authClient,
      localization: RECOVERY_LOCALIZATION,
      basePaths,
      baseURL,
      emailAndPassword: {
        ...DEFAULT_EMAIL_AND_PASSWORD,
        ...emailAndPassword,
        forgotPassword: allowPasswordRecovery && (emailAndPassword?.forgotPassword ?? true),
      },
      Link,
      navigate,
      plugins: mergeAuthUiPlugins(plugins),
      queryClient,
      redirectTo,
      signUpRedirectTo,
      socialProviders,
      viewPaths: viewPaths ?? createAuthViewPaths({ allowPasswordRecovery }),
    },
    children,
    createElement(SonnerToaster, {
      closeButton: true,
      richColors: true,
    }),
  );
}
