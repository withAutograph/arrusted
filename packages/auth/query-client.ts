import { QueryClient } from "@tanstack/react-query";

const AUTH_QUERY_STALE_TIME_MS = 5000;

let browserAuthQueryClient: QueryClient | undefined;

export function createAuthQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: AUTH_QUERY_STALE_TIME_MS,
      },
    },
  });
}

export function getAuthQueryClient() {
  if (typeof window === "undefined") {
    return createAuthQueryClient();
  }
  browserAuthQueryClient ??= createAuthQueryClient();
  return browserAuthQueryClient;
}
