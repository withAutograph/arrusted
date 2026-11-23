import { optionalString, requireArray, requireObject, requireString } from "./spec";
import type { StepRailSpec, StepRailState } from "./StepRail";

export function validateStepRailSpec(value: unknown): StepRailSpec {
  const object = requireObject(value, "step_rail.config");
  const steps = requireArray(object.steps, "step_rail.steps", (item, index) => {
    const step = requireObject(item, `step_rail.steps[${index}]`);
    return {
      id: requireString(step.id, `step_rail.steps[${index}].id`),
      title: requireString(step.title, `step_rail.steps[${index}].title`),
      subtitle: optionalString(step.subtitle, `step_rail.steps[${index}].subtitle`),
      body: optionalString(step.body, `step_rail.steps[${index}].body`),
      state: requireStepState(step.state, `step_rail.steps[${index}].state`),
      statusLabel: optionalString(step.statusLabel, `step_rail.steps[${index}].statusLabel`),
    };
  });
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`step_rail.steps contains duplicate id: ${step.id}`);
    }
    ids.add(step.id);
  }
  const activeStepId = optionalString(object.activeStepId, "step_rail.activeStepId");
  if (activeStepId && !ids.has(activeStepId)) {
    throw new Error("step_rail.activeStepId must match an existing step id");
  }
  return {
    steps,
    activeStepId,
    emptyLabel: typeof object.emptyLabel === "string" ? object.emptyLabel : "No steps yet.",
  };
}

function requireStepState(value: unknown, name: string): StepRailState {
  if (value === "done" || value === "current" || value === "pending" || value === "blocked") {
    return value;
  }
  throw new Error(`${name} must be done, current, pending, or blocked`);
}
