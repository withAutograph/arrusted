export interface SchemaCompilerCommand {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Run Cargo directly in local workflows, and resolve the locked Rust+CUE tool
 * context through the pinned provider Mise CLI when the Vercel wrapper exposes it.
 */
export function schemaCompilerCommand(
  cargoArgs: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): SchemaCompilerCommand {
  const providerMise = environment.VERCEL_MISE_BIN;
  if (!providerMise) {
    return {
      executable: "cargo",
      args: [...cargoArgs],
      env: environment,
    };
  }

  return {
    executable: providerMise,
    args: ["exec", "--locked", "--", "cargo", ...cargoArgs],
    env: {
      ...environment,
      MISE_ENABLE_TOOLS: "rust,cue",
    },
  };
}
