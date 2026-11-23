import type { AuthPluginBase } from "@better-auth-ui/core";
import type { ComponentType, ReactNode } from "react";

type AuthSlotComponent = ComponentType<Record<string, unknown>>;
type AuthButtonSlotComponent = ComponentType<{ view: string }>;

interface ShadcnAuthPlugin extends AuthPluginBase {
  authButtons?: AuthButtonSlotComponent[];
  accountCards?: AuthSlotComponent[];
  captchaComponent?: ReactNode;
  fallbackViews?: {
    auth?: Record<string, ComponentType<Record<string, unknown>>>;
  };
  securityCards?: AuthSlotComponent[];
  settingsTabs?: Array<{
    component: AuthSlotComponent;
    label: ReactNode;
    view: string;
  }>;
  userMenuItems?: AuthSlotComponent[];
  views?: {
    auth?: Record<string, ComponentType<Record<string, unknown>>>;
  };
}

declare module "@better-auth-ui/core" {
  interface AuthPluginRegister {
    ShadcnAuth: ShadcnAuthPlugin;
  }
}
