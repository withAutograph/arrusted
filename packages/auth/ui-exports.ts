import { organizationPlugin } from "@better-auth-ui/core/plugins/organization";
import { viewPaths } from "@better-auth-ui/core";
import { useSession } from "@better-auth-ui/react";
import type { AuthProviderProps } from "@better-auth-ui/react";

export { authMutationKeys, authQueryKeys, basePaths, viewPaths } from "@better-auth-ui/core";
export {
  useAuth,
  useAuthenticate,
  useAuthMutation,
  useAuthQuery,
  useSession,
  useUser,
} from "@better-auth-ui/react";
export {
  useActiveOrganization,
  useSetActiveOrganization,
} from "@better-auth-ui/react/plugins/organization";
export { organizationPlugin } from "@better-auth-ui/core/plugins/organization";

type AuthUiPlugins = NonNullable<AuthProviderProps["plugins"]>;

export const OrganizationPlugin = organizationPlugin();
export const AuthUiPlugins = [OrganizationPlugin] as const;
export const AuthUiViewPaths = {
  ...viewPaths,
  settings: {
    ...viewPaths.settings,
    organizations: OrganizationPlugin.viewPaths.settings.organizations,
  },
  organization: OrganizationPlugin.viewPaths.organization,
} as const;
export const useAuthUiSession = useSession;

export function mergeAuthUiPlugins(plugins: AuthUiPlugins): AuthUiPlugins {
  if (plugins.some((plugin) => plugin.id === OrganizationPlugin.id)) {
    return plugins;
  }
  return [...AuthUiPlugins, ...plugins];
}
