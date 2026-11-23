"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { IntegrationsSurfaceProps } from "./types";

type IntegrationActionHandlers = Pick<IntegrationsSurfaceProps, "onAction" | "onRefresh">;
const IntegrationActionContext = createContext<IntegrationActionHandlers>({});

/** Host client bridge around server-rendered children. Carries no authority or data. */
export function IntegrationActionProvider({
  children,
  onAction,
  onRefresh,
}: IntegrationActionHandlers & { children: ReactNode }) {
  const handlers = useMemo(() => ({ onAction, onRefresh }), [onAction, onRefresh]);
  return <IntegrationActionContext value={handlers}>{children}</IntegrationActionContext>;
}

export function useIntegrationActionHandlers() {
  return useContext(IntegrationActionContext);
}
