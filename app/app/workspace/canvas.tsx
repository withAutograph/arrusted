"use client";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { Canvas } from "@autograph/canvas";
import { createCanvasClient } from "@autograph/canvas-host/client";
import type { DataDefinition } from "@autograph/generated-app-runtime/data";
import * as mutations from "../data/actions";
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
  return <Canvas client={client} sessionId={sessionId} />;
}
