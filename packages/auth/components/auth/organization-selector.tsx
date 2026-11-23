"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSetActiveOrganization } from "@better-auth-ui/react/plugins/organization";

import { authClient } from "../../client";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

export type SelectableOrganization = {
  id: string;
  name: string;
  slug: string;
};

export type OrganizationSelectorProps = {
  onSelected: () => void;
  organizations: readonly SelectableOrganization[];
};

export function OrganizationSelector({ onSelected, organizations }: OrganizationSelectorProps) {
  const autoSelected = useRef(false);
  const setActiveOrganization = useSetActiveOrganization(authClient, {
    onSuccess: onSelected,
  });

  const activate = useCallback(
    (organizationId: string) => {
      setActiveOrganization.mutate({ organizationId });
    },
    [setActiveOrganization],
  );

  useEffect(() => {
    const organization = organizations[0];
    if (organizations.length !== 1 || !organization || autoSelected.current) return;
    autoSelected.current = true;
    activate(organization.id);
  }, [activate, organizations]);

  if (organizations.length === 1 && !setActiveOrganization.isError) return null;

  return (
    <main className="auth-page" aria-label="Select organization">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Select an organization</CardTitle>
          <CardDescription>Choose the organization you want to open.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {organizations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No organization access is available for this account.
            </p>
          ) : organizations.length === 1 ? (
            <Button
              type="button"
              disabled={setActiveOrganization.isPending}
              onClick={() => activate(organizations[0]!.id)}
            >
              Retry
            </Button>
          ) : (
            organizations.map((organization) => (
              <Button
                key={organization.id}
                type="button"
                variant="outline"
                disabled={setActiveOrganization.isPending}
                onClick={() => activate(organization.id)}
              >
                {organization.name}
              </Button>
            ))
          )}
          {setActiveOrganization.isError ? (
            <p className="text-sm text-destructive" role="alert">
              Organization access could not be selected.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
