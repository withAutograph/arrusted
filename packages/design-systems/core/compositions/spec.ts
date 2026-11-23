import type { ReactNode } from "react";

export type CompositionTrust = "app" | "module" | "saved_view" | "agent" | "storybook";

export type CompositionSpec<TType extends string = string, TConfig = unknown> = {
  type: TType;
  title?: string;
  description?: string;
  config: TConfig;
};

export type CompositionRenderer<TConfig> = (args: {
  spec: CompositionSpec<string, TConfig>;
  trust?: CompositionTrust;
}) => ReactNode;

export type CompositionDefinition<TConfig> = {
  type: string;
  description: string;
  render: CompositionRenderer<TConfig>;
  validate: (value: unknown) => TConfig;
};

export class CompositionRegistry {
  private definitions = new Map<string, CompositionDefinition<any>>();

  register<TConfig>(definition: CompositionDefinition<TConfig>) {
    if (this.definitions.has(definition.type)) {
      throw new Error(`composition already registered: ${definition.type}`);
    }
    this.definitions.set(definition.type, definition);
  }

  render(spec: CompositionSpec, trust: CompositionTrust = "app") {
    const definition = this.definitions.get(spec.type);
    if (!definition) {
      throw new Error(`unknown composition: ${spec.type}`);
    }
    enforceCompositionSize(spec, trust);
    const config = definition.validate(spec.config);
    return definition.render({ spec: { ...spec, config }, trust });
  }

  list() {
    return Array.from(this.definitions.values()).map(({ type, description }) => ({
      type,
      description,
    }));
  }
}

type CompositionSizeLimits = {
  maxArrayLength: number;
  maxDepth: number;
  maxObjectKeys: number;
  maxStringLength: number;
};

const TRUST_LIMITS: Partial<Record<CompositionTrust, CompositionSizeLimits>> = {
  saved_view: {
    maxArrayLength: 100,
    maxDepth: 8,
    maxObjectKeys: 100,
    maxStringLength: 10_000,
  },
  agent: {
    maxArrayLength: 100,
    maxDepth: 8,
    maxObjectKeys: 100,
    maxStringLength: 10_000,
  },
};

function enforceCompositionSize(spec: CompositionSpec, trust: CompositionTrust) {
  const limits = TRUST_LIMITS[trust];
  if (!limits) return;
  visitCompositionValue(spec, limits, "spec", 0);
}

function visitCompositionValue(
  value: unknown,
  limits: CompositionSizeLimits,
  path: string,
  depth: number,
) {
  if (depth > limits.maxDepth) {
    throw new Error(`${path} exceeds maximum composition depth for this trust tier`);
  }
  if (typeof value === "string" && value.length > limits.maxStringLength) {
    throw new Error(`${path} exceeds maximum string length for this trust tier`);
  }
  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new Error(`${path} exceeds maximum array length for this trust tier`);
    }
    value.forEach((item, index) => {
      visitCompositionValue(item, limits, `${path}[${index}]`, depth + 1);
    });
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > limits.maxObjectKeys) {
      throw new Error(`${path} exceeds maximum object key count for this trust tier`);
    }
    for (const [key, child] of entries) {
      visitCompositionValue(child, limits, `${path}.${key}`, depth + 1);
    }
  }
}

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

export function requireArray<T>(
  value: unknown,
  name: string,
  map: (item: unknown, index: number) => T,
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value.map(map);
}
