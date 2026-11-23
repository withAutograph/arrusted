"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { AppRuntime } from "@contracts";

const AppRuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: AppRuntime;
}) {
  return <AppRuntimeContext.Provider value={runtime}>{children}</AppRuntimeContext.Provider>;
}

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext);
  if (!runtime) throw new Error("Platform app runtime is unavailable");
  return runtime;
}
