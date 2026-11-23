# AON Design System Tokens

This folder validates the multi-design-system layout with a second token system
only. It intentionally does not port AON components yet.

The token file maps this implementation's paper-workbench palette onto the same
semantic token contract used by `design-systems/core`. Mirrored components can therefore import
the same semantic names (`--color-text-primary`, `--space-3`,
`--size-control-md`, etc.) while each design system chooses different values.

Port components into this folder only when a real app chooses this visual
language. Until then, treat it as theme evidence and a compatibility target
for future mirrored components.
