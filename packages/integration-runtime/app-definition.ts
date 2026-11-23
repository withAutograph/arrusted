import type { DataDefinition } from "../generated-app-runtime/data";

export type IntegrationProviderId = "quickbooks" | "xero" | "ramp";

/** A factory-produced projection. Credentials and connection authority stay in the server host. */
export type AppIntegrationSelection<D extends DataDefinition = DataDefinition> = {
  provider: IntegrationProviderId;
  /** Key of the connection system in the Integrations-owned catalog. */
  connectionProviderKey?: string;
  recipe: {
    definition: D;
    recipe: { id: string; version: string; projections: object };
  };
};

export type AppIntegrationDefinition<D extends DataDefinition = DataDefinition> = Readonly<{
  appId: string;
  definition: D;
  providers: readonly AppIntegrationSelection<D>[];
  /** App-relative server module exporting integrationHost. */
  hostModule: string;
  includePage: boolean;
}>;

/** Executable app composition, separate from human-readable AppSpec intent. */
export function defineAppIntegrations<const D extends DataDefinition>(
  definition: D,
  input: {
    appId: string;
    providers: readonly AppIntegrationSelection<NoInfer<D>>[];
    hostModule: string;
    includePage?: boolean;
  },
): AppIntegrationDefinition<D> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId)) {
    throw new Error("Integration app identity is invalid");
  }
  if (typeof definition.appId === "string" && definition.appId !== input.appId) {
    throw new Error("Generated integration schema belongs to another app");
  }
  if (!/^(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.(?:ts|tsx|mts)$/u.test(input.hostModule)) {
    throw new Error("Integration host must be an app-relative server module");
  }
  const modelsById = new Map(definition.models.map((model) => [model.id, model]));
  const providers = new Set<string>();
  const connectionProviders = new Set<string>();
  const recipes = new Set<string>();
  for (const selection of input.providers) {
    if (
      selection.connectionProviderKey !== undefined &&
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(selection.connectionProviderKey)
    ) {
      throw new Error("Invalid connection provider key");
    }
    if (!["quickbooks", "xero", "ramp"].includes(selection.provider)) {
      throw new Error("Unsupported integration provider");
    }
    if (providers.has(selection.provider))
      throw new Error("Integration provider is selected twice");
    providers.add(selection.provider);
    const connectionProvider = selection.connectionProviderKey ?? selection.provider;
    if (connectionProviders.has(connectionProvider))
      throw new Error("Connection provider is selected twice");
    connectionProviders.add(connectionProvider);
    if (selection.recipe.definition !== definition) {
      throw new Error("Integration recipes must use the app's generated schema definition");
    }
    const { recipe } = selection.recipe;
    if (!recipe.id || !recipe.version || recipes.has(recipe.id)) {
      throw new Error("Integration recipes require distinct identities and a version");
    }
    recipes.add(recipe.id);
    const projections = Object.entries(recipe.projections);
    if (projections.length === 0)
      throw new Error("Integration recipe has no supported projections");
    for (const [modelId, projection] of projections) {
      const model = modelsById.get(modelId);
      if (!model || model.kind === "lookup")
        throw new Error("Unsupported integration target model");
      if (!projection || typeof projection !== "object")
        throw new Error("Invalid integration projection");
      const candidate = projection as {
        fields?: unknown;
        normalize?: unknown;
        sourceReference?: unknown;
      };
      if (
        !Array.isArray(candidate.fields) ||
        candidate.fields.length === 0 ||
        typeof candidate.normalize !== "function" ||
        typeof candidate.sourceReference !== "function"
      )
        throw new Error("Integration recipe requires executable field and source mappings");
      for (const name of candidate.fields) {
        const field = model.fields.find((item) => item.name === name);
        if (!field || field.readOnly || field.lifecycle === "retired") {
          throw new Error("Integration recipe maps an unknown or nonwritable schema field");
        }
      }
    }
  }
  return Object.freeze({
    ...input,
    definition,
    providers: Object.freeze(input.providers.map((selection) => Object.freeze({ ...selection }))),
    includePage: input.includePage ?? false,
  });
}
