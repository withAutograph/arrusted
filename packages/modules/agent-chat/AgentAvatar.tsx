// AgentAvatar — the small sparkle mark that stands in for the assistant.
//
// One shared definition: the panel header, the empty state, and every agent
// turn render THIS leaf (it used to be copy-pasted in AgentChatPanel.tsx and
// Message.tsx). Borderless — the `bg-selected` tint + the sparkle glyph carry
// the mark on their own; a hairline border read as a heavier "chip" than the
// playground idiom wants.

import { Sparkles } from "@autograph/icons";
import { cx } from "@autograph/components";

export type AgentAvatarProps = {
  className?: string;
};

export function AgentAvatar(props: AgentAvatarProps) {
  const { className } = props;
  return (
    <span
      aria-hidden="true"
      className={cx(
        "flex size-[var(--size-control-xs)] shrink-0 items-center justify-center",
        "rounded-[var(--radius-pill)]",
        "bg-[var(--color-bg-selected)] text-[var(--color-action-primary)]",
        className,
      )}
    >
      <Sparkles className="size-[var(--size-icon-sm)]" />
    </span>
  );
}
