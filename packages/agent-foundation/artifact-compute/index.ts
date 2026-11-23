import { getQuickJS } from "quickjs-emscripten";

export type ArtifactComputationLimits = {
  timeoutMs: number;
  memoryBytes: number;
  inputBytes: number;
  outputBytes: number;
};

const CEILING: ArtifactComputationLimits = {
  timeoutMs: 2_000,
  memoryBytes: 64 * 1024 * 1024,
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024,
};
const encoder = new TextEncoder();

/** Shared preflight for hosts that must reject impossible work before invoking a model. */
export function prepareArtifactComputationInput(input: unknown, maxBytes = CEILING.inputBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CEILING.inputBytes)
    throw new Error("Invalid computation limit: inputBytes");
  const encodedInput = JSON.stringify(input);
  if (encodedInput === undefined) throw new Error("Computation input must be JSON");
  const inputBytes = encoder.encode(encodedInput).length;
  if (inputBytes > maxBytes)
    throw new Error(`Computation input limit exceeded: ${inputBytes} bytes; maximum ${maxBytes}.`);
  return { encodedInput, inputBytes };
}

/** A fresh capability-free interpreter for each synchronous JSON transform.
 * Limits apply to the QuickJS heap/execution, not the entire host process.
 * The caller supplies a JavaScript function expression and all data/IDs.
 */
export async function executeArtifactComputation(request: {
  code: string;
  input: unknown;
  limits?: Partial<ArtifactComputationLimits>;
}): Promise<{
  value: unknown;
  metrics: { elapsedMs: number; inputBytes: number; outputBytes: number };
}> {
  if (typeof request.code !== "string" || encoder.encode(request.code).length > 64 * 1024) {
    throw new Error("Computation code exceeds 64 KiB");
  }
  const limits = { ...CEILING, ...request.limits };
  for (const name of Object.keys(CEILING) as (keyof ArtifactComputationLimits)[]) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > CEILING[name]) {
      throw new Error(`Invalid computation limit: ${name}`);
    }
  }
  const { encodedInput, inputBytes } = prepareArtifactComputationInput(
    request.input,
    limits.inputBytes,
  );

  const started = performance.now();
  const engine = await getQuickJS();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  const deadline = performance.now() + limits.timeoutMs;
  runtime.setInterruptHandler(() => performance.now() >= deadline);
  const context = runtime.newContext();
  try {
    // No host functions, module loader, filesystem or networking are installed.
    // Remove ambient entropy/time; generated IDs arrive in the captured input.
    const bootstrap = context.evalCode(`
      "use strict";
      for (const key of ["Date", "WeakRef", "FinalizationRegistry"]) {
        Object.defineProperty(globalThis, key, { value: undefined, configurable: false, writable: false });
      }
      Object.defineProperty(Math, "random", { value: undefined, configurable: false, writable: false });
    `);
    if (bootstrap.error) {
      bootstrap.error.dispose();
      throw new Error("Computation runtime initialization failed");
    }
    bootstrap.value.dispose();
    const result = context.evalCode(
      `
      (() => {
        "use strict";
        const parse = JSON.parse;
        const stringify = JSON.stringify;
        const transform = (${request.code});
        if (typeof transform !== "function") throw new Error("Expected a function expression");
        const value = transform(parse(${JSON.stringify(encodedInput)}));
        if (value && typeof value.then === "function") throw new Error("Async transforms are unsupported");
        const encoded = stringify(value);
        if (typeof encoded !== "string") throw new Error("Transform must return JSON");
        if (encoded.length > ${limits.outputBytes}) throw new Error("Computation output limit exceeded");
        return encoded;
      })()
    `,
      "artifact-transform.js",
    );
    if (result.error) {
      let message = "Computation failed";
      try {
        const detail = context.dump(result.error) as { message?: unknown } | null;
        if (typeof detail?.message === "string") message = detail.message.slice(0, 500);
      } finally {
        result.error.dispose();
      }
      throw new Error(message);
    }
    let encodedOutput: string;
    try {
      encodedOutput = context.getString(result.value);
    } finally {
      result.value.dispose();
    }
    const outputBytes = encoder.encode(encodedOutput).length;
    if (outputBytes > limits.outputBytes) throw new Error("Computation output limit exceeded");
    return {
      value: JSON.parse(encodedOutput),
      metrics: { elapsedMs: performance.now() - started, inputBytes, outputBytes },
    };
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
