/** Browser-safe setup result. Provider credentials and broad SDK tokens stay server-side. */
export type ConnectionSetup = {
  setupId: string;
  authorizationUrl: string;
};

export type ConnectionSetupCheck = { status: "pending" } | { status: "connected" };

export type AppConnectionSetup = {
  prepareConnection(providerId: string): Promise<ConnectionSetup>;
  completeConnection(providerId: string, setupId: string): Promise<ConnectionSetupCheck>;
};

/** Server-only adapter. Completion is verified independently before central registration. */
export type ConnectionSetupAdapter = {
  availability(
    request: Request,
  ): Promise<
    | { status: "available" }
    | { status: "unavailable"; code: "provider_oauth_setup_unavailable"; reason: string }
  >;
  prepare(request: Request): Promise<ConnectionSetup>;
  complete(
    request: Request,
    setupId: string,
  ): Promise<
    | { status: "pending" }
    | { status: "verified"; externalConnectionId: string; externalGroupRef: string }
  >;
};
