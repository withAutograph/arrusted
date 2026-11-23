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
  AGENT_GRANT_LOGIN_PAGE,
  appAccessMissing,
  appDisplayName,
  canvasGrantConsent,
} from "../../agent-grant-policy";

type DeviceContext = {
  app: { id: string; resource: string };
  organizations: { id: string; name: string }[];
  picked: { id: string; name: string } | null;
};

class DeviceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
    throw new DeviceRequestError(
      response.status,
      typeof json.error_description === "string"
        ? json.error_description
        : typeof json.message === "string"
          ? json.message
          : "The request could not be completed.",
    );
  return json;
}

/**
 * The canvas device sign-in page (`/auth/device?user_code=…`): the person
 * signs in if needed, picks the organization for this code and approves the
 * canvas in their chat acting as them. Approve records the grant, then
 * approves the code; the frame's poll then receives its token.
 */
export function CanvasDevicePage() {
  const userCode =
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("user_code") ?? "");
  const [context, setContext] = useState<DeviceContext | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (userCode === "") {
      setError("This page needs the code shown in your chat.");
      return;
    }
    post("/canvas-grant/context", { user_code: userCode })
      .then((value) => {
        if (cancelled) return;
        const loaded = value as unknown as DeviceContext;
        setContext(loaded);
        setChosen(
          loaded.picked?.id ??
            (loaded.organizations.length === 1 ? loaded.organizations[0]!.id : null),
        );
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        // Not signed in: sign in, then back to this same code.
        if (reason instanceof DeviceRequestError && reason.status === 401) {
          const back = `${window.location.pathname}${window.location.search}`;
          window.location.assign(
            `${AGENT_GRANT_LOGIN_PAGE}?${new URLSearchParams({ next: back, redirectTo: back })}`,
          );
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [userCode]);

  async function approve() {
    if (chosen === null) return;
    setBusy(true);
    try {
      await post("/canvas-grant/organization", { user_code: userCode, organizationId: chosen });
      await post("/device/approve", { userCode });
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    setBusy(true);
    try {
      await post("/device/deny", { userCode });
      setError("You declined. The canvas in your chat stays signed out.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  const name = context === null ? "the canvas" : appDisplayName(context.app.id);
  return (
    <main className="flex min-h-svh items-center justify-center p-4" aria-label="Canvas sign-in">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{done ? "You're signed in" : `Sign in to ${name} in your chat`}</CardTitle>
          <CardDescription>
            {done
              ? "Go back to your chat; the canvas opens there in a moment."
              : `Code ${userCode || "missing"}. Check it matches the one in your chat.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          {context && !done ? (
            context.organizations.length === 0 ? (
              <p className="text-sm">{appAccessMissing(context.app.id)}</p>
            ) : (
              <>
                <fieldset
                  className="flex flex-col gap-2"
                  hidden={context.organizations.length === 1}
                >
                  <legend className="mb-1 text-sm font-medium">Organization</legend>
                  {context.organizations.map((organization) => (
                    <label key={organization.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="organization"
                        value={organization.id}
                        checked={chosen === organization.id}
                        disabled={busy}
                        onChange={() => setChosen(organization.id)}
                      />
                      {organization.name}
                    </label>
                  ))}
                </fieldset>
                <p className="text-sm">{canvasGrantConsent(name)}</p>
              </>
            )
          ) : null}
        </CardContent>
        {context && !done && context.organizations.length > 0 ? (
          <CardFooter className="flex gap-2">
            <Button variant="outline" disabled={busy} onClick={() => void deny()}>
              Deny
            </Button>
            <Button disabled={busy || chosen === null} onClick={() => void approve()}>
              Approve
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
