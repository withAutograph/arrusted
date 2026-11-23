// Breadcrumbs — the trail back up from a page that is not a top-level
// destination. Pairs with `PageTabs`: the strip carries the places you can go,
// the trail carries the place you came from.
//
// Non-obvious behaviors:
//   - The last entry is the current page. It is rendered as plain text with
//     `aria-current="page"`, never as a link -- a link to where you already are
//     is a promise the app cannot keep.
//   - Separators are `aria-hidden`; a screen reader hears the list structure
//     instead of a run of slashes.
//   - Rendering is delegated: the consumer passes whatever its router wants for
//     an anchor, so this leaf never learns what framework it is inside.

import type { ReactNode } from "react";

import { cx } from "./utils";

export type BreadcrumbEntry = {
  /** The label a reader sees. Name the destination, not the action. */
  label: string;
  /** Where it goes. Omitted on the current page, which is not a link. */
  href?: string;
};

export type BreadcrumbsProps = {
  entries: ReadonlyArray<BreadcrumbEntry>;
  /**
   * Renders one linked crumb. The consumer owns this so the trail can use the
   * app's router (and keep prefetch, middle-click, and copy-link working)
   * without this component importing one.
   */
  renderLink: (entry: BreadcrumbEntry & { href: string }) => ReactNode;
  ariaLabel?: string;
  className?: string;
};

export function Breadcrumbs(props: BreadcrumbsProps) {
  const { entries, renderLink, ariaLabel = "Breadcrumb", className } = props;
  // One crumb is just the page title, which the page header already states.
  if (entries.length <= 1) return null;
  return (
    <nav aria-label={ariaLabel} data-breadcrumbs className={className}>
      <ol
        className={cx(
          "m-0 flex list-none flex-wrap items-center gap-[var(--space-1-5)] p-0",
          "text-[length:var(--text-control-sm)] leading-[var(--leading-body)]",
        )}
      >
        {entries.map((entry, index) => {
          const isCurrent = index === entries.length - 1;
          return (
            <li
              key={`${entry.label}:${entry.href ?? ""}`}
              className="flex items-center gap-[var(--space-1-5)]"
            >
              {index > 0 ? (
                <span aria-hidden="true" className="text-[var(--color-text-muted)]">
                  /
                </span>
              ) : null}
              {isCurrent || entry.href == null ? (
                <span
                  aria-current={isCurrent ? "page" : undefined}
                  className="text-[var(--color-text-secondary)]"
                >
                  {entry.label}
                </span>
              ) : (
                renderLink({ ...entry, href: entry.href })
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/*
 * The class list for a linked crumb, so the consumer's anchor looks right
 * without this component owning the anchor. Same reasoning as `buttonClassName`.
 */
export const breadcrumbLinkClassName = cx(
  "rounded-[var(--radius-control)] text-[var(--color-text-muted)] no-underline",
  "transition-colors hover:text-[var(--color-text-primary)]",
);
