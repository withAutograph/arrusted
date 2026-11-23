import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import {
  PrefetchCrossZoneLinks,
  PrefetchCrossZoneLinksProvider,
} from "@vercel/microfrontends/next/client";
import { describe, expect, it } from "vite-plus/test";

import ExampleNextLayout from "../layout";

describe("Next route-owned example navigation", () => {
  it("mounts the official cross-zone prefetch client at the root", () => {
    const elements = collectElements(ExampleNextLayout({ children: createElement("main") }));

    expect(elements.filter((element) => element.type === PrefetchCrossZoneLinksProvider)).toHaveLength(
      1,
    );
    expect(elements.filter((element) => element.type === PrefetchCrossZoneLinks)).toHaveLength(1);
  });
});

function collectElements(node: ReactNode): ReactElement<{ children?: ReactNode }>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child)
      ? [child, ...collectElements(child.props.children)]
      : [],
  );
}
