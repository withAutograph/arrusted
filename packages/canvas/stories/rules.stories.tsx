import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";

import type { CanvasClient } from "../client";
import { RuleCard } from "../rule-card";
import { useCanvasSession } from "../use-canvas-session";
import {
  act,
  definition,
  ids,
  refusing,
  rules,
  useSeededCanvas,
  type StoryCanvas,
} from "./fixtures/threads-rules";

type Seed = (canvas: StoryCanvas) => Promise<void>;

function RulesStory({
  setup,
  wrap,
}: {
  setup: Seed;
  wrap?: (client: CanvasClient) => CanvasClient;
}) {
  const { canvas, ready } = useSeededCanvas(setup);
  const [client] = useState(() => wrap?.(canvas.client) ?? canvas.client);
  const session = useCanvasSession(client, ids.session);
  if (!ready) return null;
  return (
    <div className="flex min-h-screen flex-col gap-[var(--space-3)] bg-[var(--color-bg-page)] p-[var(--space-6)] font-[var(--font-sans)]">
      <div className="flex max-w-[30rem] flex-col gap-[var(--space-3)]">
        {session.rules.length === 0 ? (
          <p className="m-[var(--space-0)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            No rules.
          </p>
        ) : (
          session.rules.map((rule) => (
            <RuleCard definition={definition} key={rule.id} rule={rule} session={session} />
          ))
        )}
      </div>
    </div>
  );
}

const meta = {
  title: "Canvas/Rules",
  component: RulesStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RulesStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ByYou: Story = {
  args: {
    setup: async (canvas) => {
      await act(canvas, { operation: "rule_create", rule_id: "rule-at-risk", rule: rules.atRisk });
    },
  },
};

export const ByAgentWithMoney: Story = {
  args: {
    setup: async (canvas) => {
      await act(
        canvas,
        { operation: "rule_create", rule_id: "rule-rate-floor", rule: rules.rateFloor },
        ids.turn,
      );
    },
  },
};

export const Both: Story = {
  args: {
    setup: async (canvas) => {
      await act(canvas, { operation: "rule_create", rule_id: "rule-at-risk", rule: rules.atRisk });
      await act(
        canvas,
        { operation: "rule_create", rule_id: "rule-rate-floor", rule: rules.rateFloor },
        ids.turn,
      );
    },
  },
};

/** The kernel refuses a parameter change; the card shows its message and keeps the value. */
export const ParameterRefused: Story = {
  args: {
    setup: async (canvas) => {
      await act(
        canvas,
        { operation: "rule_create", rule_id: "rule-rate-floor", rule: rules.rateFloor },
        ids.turn,
      );
    },
    wrap: (client) =>
      refusing(
        client,
        "rule_parameters",
        "contract_validation_failed",
        "Day rate must be in the column's currency (GBP).",
      ),
  },
};
