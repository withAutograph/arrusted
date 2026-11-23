// oxlint-disable react-doctor/only-export-components -- Public UI barrel intentionally re-exports hooks, constants, and components.
import "./components/auth/plugin-slots";

export type { AuthUiProviderProps, AuthUiLinkComponent, AuthUiNavigate } from "./ui-provider";
export { authClient } from "./client";
export { Auth } from "./components/auth/auth";
export { AgentGrantPage, type AgentGrantStep } from "./components/auth/agent-grant";
export { CanvasDevicePage } from "./components/auth/canvas-device";
export { OrganizationSelector } from "./components/auth/organization-selector";
export { UserButton } from "./components/auth/user/user-button";
export { createAuthQueryClient, getAuthQueryClient } from "./query-client";
export { AuthUiProvider } from "./ui-provider";
export { AUTH_SIGN_IN_VIEW_PATH, createAuthViewPaths } from "./ui-view-paths";
export {
  AuthUiPlugins,
  AuthUiViewPaths,
  OrganizationPlugin,
  authMutationKeys,
  authQueryKeys,
  basePaths,
  mergeAuthUiPlugins,
  organizationPlugin,
  useActiveOrganization,
  useAuth,
  useAuthenticate,
  useAuthMutation,
  useAuthQuery,
  useAuthUiSession,
  useSession,
  useSetActiveOrganization,
  useUser,
  viewPaths,
} from "./ui-exports";
