import { useSyncExternalStore } from "react";
import type { MouseEvent, ReactNode } from "react";

export type ExampleRoute = "details" | "home" | "not-found";
export const nextExamplePath = "/example-next";

export function useExampleRoute(): ExampleRoute {
  return useSyncExternalStore(subscribe, currentRoute, () => "home");
}

export function RouterLink({
  children,
  route,
}: {
  children: ReactNode;
  route: Exclude<ExampleRoute, "not-found">;
}) {
  const href = routePath(route, import.meta.env.BASE_URL);

  function follow(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  return (
    <a className="primary-link" data-same-application="router-link" href={href} onClick={follow}>
      {children}
    </a>
  );
}

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify);
  return () => window.removeEventListener("popstate", notify);
}

function currentRoute(): ExampleRoute {
  return routeFromPathname(window.location.pathname, import.meta.env.BASE_URL);
}

export function routeFromPathname(pathname: string, baseUrl: string): ExampleRoute {
  const currentPath = normalizePathname(pathname);
  const mountPath = normalizeMountPath(baseUrl);
  if (currentPath === mountPath) return "home";
  if (currentPath === appendRoute(mountPath, "details")) return "details";
  return "not-found";
}

export function routePath(route: Exclude<ExampleRoute, "not-found">, baseUrl: string): string {
  const mountPath = normalizeMountPath(baseUrl);
  if (route === "home") return mountPath;
  return appendRoute(mountPath, "details");
}

export function normalizeMountPath(baseUrl: string): string {
  const pathname = new URL(baseUrl, "https://route-owned.invalid").pathname;
  return normalizePathname(pathname);
}

function normalizePathname(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function appendRoute(mountPath: string, segment: string): string {
  return mountPath === "/" ? `/${segment}` : `${mountPath}/${segment}`;
}
