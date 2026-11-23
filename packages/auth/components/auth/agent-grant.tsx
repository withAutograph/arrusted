"use client";

import { useEffect, useState } from "react";
import { Button } from "#components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#components/ui/card";

import {
  AGENT_GRANT_ALLOWED,
  AGENT_GRANT_DENIED,
  AGENT_GRANT_ORGANIZATION_PAGE,
  appAccessMissing,
  appDisplayName,
} from "../../agent-grant-policy";

type GrantContext = {
  app: { id: string; resource: string };
  client: { name: string | null; uri: string | null; verifiedDomain: string | null };
  organizations: { id: string; name: string }[];
  picked: { id: string; name: string } | null;
};

export type AgentGrantStep = "organization" | "consent";

/** The signed OAuth query this page was sent with (signature and its fields only). */
function signedOAuthQuery(): string {
  return typeof window === "undefined" ? "" : window.location.search.replace(/^\?/u, "");
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/auth${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.message === "string"
          ? json.message
          : "The request could not be completed.",
    );
  return json;
}

const follow = (result: Record<string, unknown>) => {
  const url = result.url ?? result.redirect_uri;
  if (typeof url === "string") window.location.assign(url);
};

/**
 * The agent grant pages of the OAuth flow: choose the organization this
 * agent works in (skipped when there is exactly one), then consent. The
 * organization is bound to this authorization request only.
 */
export function AgentGrantPage({ step }: { step: AgentGrantStep }) {
  const [context, setContext] = useState<GrantContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    post("/agent-grant/context", { oauth_query: signedOAuthQuery() })
      .then(async (value) => {
        const loaded = value as unknown as GrantContext;
        if (cancelled) return;
        // Exactly one organization: choose it without asking.
        if (step === "organization" && loaded.organizations.length === 1) {
          await choose(loaded.organizations[0]!.id);
          return;
        }
        // No current pick (it expired, or the page was opened directly):
        // choose again for this same signed request.
        if (step === "consent" && loaded.picked === null) {
          window.location.assign(`${AGENT_GRANT_ORGANIZATION_PAGE}?${signedOAuthQuery()}`);
          return;
        }
        setContext(loaded);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
    // The signed query is fixed for the page's lifetime.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function choose(organizationId: string) {
    setBusy(true);
    try {
      const oauthQuery = signedOAuthQuery();
      await post("/agent-grant/organization", { oauth_query: oauthQuery, organizationId });
      follow(await post("/oauth2/continue", { oauth_query: oauthQuery, postLogin: true }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  async function decide(accept: boolean) {
    setBusy(true);
    try {
      follow(await post("/oauth2/consent", { accept, oauth_query: signedOAuthQuery() }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  const clientName = context?.client.name ?? "An MCP client";
  const clientOrigin = context?.client.verifiedDomain
    ? `Verified domain: ${context.client.verifiedDomain}`
    : "This client described itself; its name is not verified.";

  return (
    <main className="flex min-h-svh items-center justify-center p-4" aria-label="Agent access">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            {step === "organization" ? "Choose an organization" : `Allow ${clientName}?`}
          </CardTitle>
          <CardDescription>
            {context
              ? `${clientName} wants to work in ${appDisplayName(context.app.id)} as you. ${clientOrigin}`
              : error
                ? "This request cannot continue."
                : "Loading…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          {context && step === "organization" ? (
            context.organizations.length === 0 ? (
              <p className="text-sm">{appAccessMissing(context.app.id)}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {context.organizations.map((organization) => (
                  <li key={organization.id}>
                    <Button
                      className="w-full justify-start"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void choose(organization.id)}
                    >
                      {organization.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {context && step === "consent" ? (
            <>
              <p className="text-sm">
                Organization: <strong>{context.picked?.name ?? "not chosen"}</strong>
              </p>
              <div className="text-sm">
                <p className="font-medium">It may</p>
                <ul className="list-disc pl-5">
                  {AGENT_GRANT_ALLOWED.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div className="text-sm">
                <p className="font-medium">It may not</p>
                <ul className="list-disc pl-5">
                  {AGENT_GRANT_DENIED.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </CardContent>
        {context && step === "consent" ? (
          <CardFooter className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void decide(false)}>
              Deny
            </Button>
            <Button disabled={busy || context.picked === null} onClick={() => void decide(true)}>
              Allow
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
