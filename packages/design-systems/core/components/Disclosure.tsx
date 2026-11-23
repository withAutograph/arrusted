import { useState, type DetailsHTMLAttributes, type ReactNode } from "react";

import { ChevronDown, ChevronRight } from "../icons";
import { cx } from "./utils";

export type DisclosureProps = Omit<
  DetailsHTMLAttributes<HTMLDetailsElement>,
  "children" | "onToggle" | "open"
> & {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  summaryClassName?: string;
  caretPosition?: "start" | "end";
  caretSize?: "xs" | "md";
  caretMotion?: "right-down" | "up-down";
};

/** A native disclosure with the shared design-system caret and open-state motion. */
export function Disclosure(props: DisclosureProps) {
  const {
    summary,
    children,
    open,
    defaultOpen = false,
    onOpenChange,
    summaryClassName,
    caretPosition = "start",
    caretSize = "xs",
    caretMotion = "right-down",
    className,
    ...detailsProps
  } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;

  return (
    <details
      {...detailsProps}
      open={isControlled ? open : uncontrolledOpen}
      data-caret-motion={caretMotion}
      className={cx("ds-disclosure", className)}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (!isControlled) {
          setUncontrolledOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }
      }}
    >
      <summary
        onClick={(event) => {
          if (!isControlled) return;
          event.preventDefault();
          onOpenChange?.(!open);
        }}
        className={cx(
          "flex cursor-pointer list-none items-center gap-[var(--space-2)] [&::-webkit-details-marker]:hidden",
          summaryClassName,
        )}
      >
        {caretPosition === "start" ? (
          <DisclosureCaret motion={caretMotion} size={caretSize} />
        ) : null}
        {summary}
        {caretPosition === "end" ? (
          <DisclosureCaret className="ml-auto" motion={caretMotion} size={caretSize} />
        ) : null}
      </summary>
      {children}
    </details>
  );
}

function DisclosureCaret(props: {
  className?: string;
  motion: "right-down" | "up-down";
  size: "xs" | "md";
}) {
  const Caret = props.motion === "up-down" ? ChevronDown : ChevronRight;
  return (
    <Caret
      aria-hidden="true"
      data-disclosure-caret
      className={cx(
        "shrink-0 text-[var(--color-text-muted)] transition-transform",
        props.size === "md" ? "size-[var(--size-icon-md)]" : "size-[var(--size-icon-xs)]",
        props.className,
      )}
    />
  );
}
