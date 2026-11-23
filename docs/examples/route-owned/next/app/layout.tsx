import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  PrefetchCrossZoneLinks,
  PrefetchCrossZoneLinksProvider,
} from "@vercel/microfrontends/next/client";

import "./styles.css";

export const metadata: Metadata = {
  description: "A native Next.js route-owned microfrontend example.",
  title: "Next route-owned example | Autograph",
};

export default function ExampleNextLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <PrefetchCrossZoneLinksProvider>{children}</PrefetchCrossZoneLinksProvider>
        <PrefetchCrossZoneLinks />
      </body>
    </html>
  );
}
