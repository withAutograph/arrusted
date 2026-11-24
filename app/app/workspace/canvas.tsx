"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Canvas } from "@autograph/canvas";
import { createCanvasClient } from "@autograph/canvas-host/client";
import { bootstrapAgCharts } from "@autograph/compositions";
import { bootstrapAgGrid } from "@modules/editable-grid";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import * as mutations from "../data/actions";
// Optional Enterprise licences; without them AG Grid and AG Charts Community are used.
bootstrapAgCharts({ licenseKey: process.env.NEXT_PUBLIC_AG_CHARTS_LICENSE_KEY });
const gridReady = bootstrapAgGrid({ licenseKey: process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY });

export function CanvasWorkspace({
  definition,
  sessionId,
  canApprove,
}: {
  definition: DataDefinition;
  sessionId: string;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let mounted = true;
    void gridReady
      // A failed Enterprise load leaves the Community grid working.
      .catch((error: unknown) => console.error("[editable-grid] Enterprise failed to load", error))
      .then(() => mounted && setReady(true));
    return () => {
      mounted = false;
    };
  }, []);
  const client = useMemo(
    () =>
      createCanvasClient(
        { mutations, readUrl: "/api/canvas/read", eventsUrl: "/api/canvas/events" },
        definition,
        {
          canApprove,
          authors: false,
          sessions: {
            home: "/",
            href: (id) => `/starter/${id}`,
            navigate: (href) => router.push(href),
          },
        },
      ),
    [definition, canApprove, router],
  );
  if (!ready) return null;
  return <Canvas client={client} sessionId={sessionId} />;
}
