import { Disclosure } from "../components/Disclosure";
import { StatusPill, type StatusPillTone } from "../components/StatusPill";
import type { CompositionSpec } from "./spec";

export type StepRailState = "done" | "current" | "pending" | "blocked";

export type StepRailStepSpec = {
  id: string;
  title: string;
  subtitle?: string;
  body?: string;
  state: StepRailState;
  statusLabel?: string;
};

export type StepRailSpec = {
  steps: StepRailStepSpec[];
  activeStepId?: string;
  emptyLabel?: string;
};

export function StepRailComposition(props: { spec: CompositionSpec<"step_rail", StepRailSpec> }) {
  const { steps, activeStepId, emptyLabel } = props.spec.config;
  return (
    <section className="overflow-hidden rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
      {props.spec.title || props.spec.description ? (
        <header className="border-b border-[var(--color-border-subtle)] px-[var(--space-5)] py-[var(--space-4)]">
          {props.spec.title ? (
            <h3 className="text-[length:var(--text-micro)] font-[var(--font-weight-semibold)] uppercase tracking-[var(--tracking-micro)] text-[var(--color-text-muted)]">
              {props.spec.title}
            </h3>
          ) : null}
          {props.spec.description ? (
            <p className="mt-[var(--space-2)] text-[length:var(--text-control-sm)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]">
              {props.spec.description}
            </p>
          ) : null}
        </header>
      ) : null}
      <div className="flex flex-col gap-[var(--space-3)] p-[var(--space-3)]">
        {steps.length === 0 ? (
          <div className="rounded-[var(--radius-control)] border border-dashed border-[var(--color-border-strong)] p-[var(--space-6)] text-[length:var(--text-body)] text-[var(--color-text-muted)]">
            {emptyLabel}
          </div>
        ) : (
          steps.map((step, index) => {
            const summary = (
              <>
                <span className={stepIndexClass[step.state]}>{index + 1}</span>
                <span className="min-w-[var(--space-0)] flex-1">
                  <span className="block text-[length:var(--text-control-lg)] font-[var(--font-weight-semibold)] leading-[var(--leading-body)] text-[var(--color-text-primary)]">
                    {step.title}
                  </span>
                  {step.subtitle ? (
                    <span className="mt-[var(--space-1)] block text-[length:var(--text-body)] text-[var(--color-text-muted)]">
                      {step.subtitle}
                    </span>
                  ) : null}
                </span>
                <StatusPill
                  tone={stepTone[step.state]}
                  label={step.statusLabel ?? stepStateLabel[step.state]}
                />
              </>
            );
            if (!step.body) {
              return (
                <div
                  key={step.id}
                  className={`${stepContainerClass[step.state]} flex items-start gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-4)] py-[var(--space-4)]`}
                >
                  {summary}
                </div>
              );
            }
            return (
              <Disclosure
                key={step.id}
                defaultOpen={activeStepId ? activeStepId === step.id : step.state === "current"}
                className={stepContainerClass[step.state]}
                summaryClassName="items-start gap-[var(--space-3)] rounded-[var(--radius-control)] px-[var(--space-4)] py-[var(--space-4)]"
                summary={summary}
              >
                <div className="border-t border-[var(--color-border-subtle)] px-[var(--space-3)] pb-[var(--space-3)] pt-[var(--space-2)] text-[length:var(--text-body)] leading-[var(--leading-prose)] text-[var(--color-text-secondary)]">
                  {step.body}
                </div>
              </Disclosure>
            );
          })
        )}
      </div>
    </section>
  );
}

const stepTone: Record<StepRailState, StatusPillTone> = {
  done: "success",
  current: "info",
  pending: "neutral",
  blocked: "danger",
};

const stepStateLabel: Record<StepRailState, string> = {
  done: "Done",
  current: "Current",
  pending: "Pending",
  blocked: "Blocked",
};

const stepContainerClass: Record<StepRailState, string> = {
  done: "rounded-[var(--radius-control)] border border-[var(--color-status-success-bg)] bg-[var(--color-status-success-bg)]",
  current:
    "rounded-[var(--radius-control)] border border-[var(--color-action-primary)] bg-[var(--color-bg-selected)]",
  pending:
    "rounded-[var(--radius-control)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]",
  blocked:
    "rounded-[var(--radius-control)] border border-[var(--color-status-danger)] bg-[var(--color-status-danger-bg)]",
};

const stepIndexClass: Record<StepRailState, string> = {
  done: "inline-flex h-[var(--size-step-index)] w-[var(--size-step-index)] shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-status-success)] text-[var(--color-text-inverse)] text-[length:var(--text-body)] font-[var(--font-weight-semibold)] tabular-nums",
  current:
    "inline-flex h-[var(--size-step-index)] w-[var(--size-step-index)] shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-action-primary)] text-[var(--color-text-inverse)] text-[length:var(--text-body)] font-[var(--font-weight-semibold)] tabular-nums",
  pending:
    "inline-flex h-[var(--size-step-index)] w-[var(--size-step-index)] shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-bg-muted)] text-[var(--color-text-muted)] text-[length:var(--text-body)] font-[var(--font-weight-semibold)] tabular-nums",
  blocked:
    "inline-flex h-[var(--size-step-index)] w-[var(--size-step-index)] shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[var(--color-status-danger)] text-[var(--color-text-inverse)] text-[length:var(--text-body)] font-[var(--font-weight-semibold)] tabular-nums",
};
