import type { FieldId, ModelId } from "../contracts/index";
import type { LanguageModel, LanguageModelUsage, ToolExecutionOptions } from "ai";

type AiModule = typeof import("ai");
type GenerateText = AiModule["generateText"];
type StreamText = AiModule["streamText"];
type GenerateTextOptions = Parameters<GenerateText>[0];
type StreamTextOptions = Parameters<StreamText>[0];
type AiJsonSchema = Parameters<AiModule["jsonSchema"]>[0];

export type AgentToolGroupId = string;
export type AgentIdentityId = string;
export type AgentExecutionProfileId = string;
export type AgentRunId = string;
export type AgentProviderId = string;
export type AgentModelId = string;

export type AgentBudgetPolicy = {
  maxWallTimeMs?: number;
};

export type AgentModelPolicy = {
  provider: AgentProviderId;
  model: AgentModelId;
  temperature?: number;
};

export type AgentExecutionProfile = {
  id: AgentExecutionProfileId;
  label: string;
  model: AgentModelPolicy;
  /** Per-invocation fuse for model/tool loops. Omit when the profile has no tools. */
  maxSteps?: number;
  retryLimit: number;
  toolGroups: readonly AgentToolGroupId[];
  budget: AgentBudgetPolicy;
};

export type AgentIdentity = {
  id: AgentIdentityId;
  name: string;
  purpose: string;
  baseInstructions: string;
  allowedToolGroups: readonly AgentToolGroupId[];
  defaultExecutionProfile: AgentExecutionProfileId;
  budget: AgentBudgetPolicy;
};

export type AgentStepMetadata = {
  runId: AgentRunId;
  identityId: AgentIdentityId;
  executionProfileId: AgentExecutionProfileId;
  provider: AgentProviderId;
  model: AgentModelId;
  inputTokens?: number;
  outputTokens?: number;
  toolSurface: readonly string[];
  finishReason?: string;
};

export type AgentTextRunRequest = {
  runId: AgentRunId;
  identity: AgentIdentity;
  executionProfile: AgentExecutionProfile;
  prompt: string;
  messages?: GenerateTextOptions["messages"];
  tools?: readonly AgentRuntimeTool[];
  output?: GenerateTextOptions["output"];
  model?: LanguageModel;
  abortSignal?: AbortSignal;
};

export type AgentTextStreamEvent =
  | { type: "tool_start"; callId: string; toolName: string }
  | { type: "tool_end"; callId: string; toolName: string; status: "done" | "error" }
  | { type: "text_delta"; delta: string };

export type AgentTextStreamCallbacks = {
  onEvent?: (event: AgentTextStreamEvent) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
};

export type AgentRuntimeTool = {
  definition: AgentToolDefinition;
  execute: (input: unknown, options?: ToolExecutionOptions<unknown>) => Promise<unknown> | unknown;
};

/** Returns the runtime tools actually granted by an execution profile. */
export function agentGrantedTools(
  executionProfile: AgentExecutionProfile,
  tools: readonly AgentRuntimeTool[] = [],
): AgentRuntimeTool[] {
  const grantedGroups = new Set(executionProfile.toolGroups);
  const toolsById = new Map<string, AgentRuntimeTool>();
  for (const tool of tools) {
    if (grantedGroups.has(tool.definition.groupId)) {
      toolsById.set(tool.definition.id, tool);
    }
  }
  return [...toolsById.values()];
}

export type AgentTextRunResult = {
  text: string;
  output?: unknown;
  metadata: AgentStepMetadata;
  toolCalls: readonly unknown[];
  toolResults: readonly unknown[];
  steps: readonly AgentTextRunStep[];
};

export type AgentTextRunStep = {
  stepNumber: number;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  toolCalls: readonly unknown[];
  toolResults: readonly unknown[];
  // The step's raw content parts when the provider exposes them. Load-bearing
  // for correct tool-call pairing: the AI SDK excludes thrown tool errors from
  // `toolResults` — they exist only as `tool-error` content parts, so callers
  // that pair calls to results need `content` to see the errors at all.
  content?: readonly unknown[];
};

export type AgentToolOutcome = {
  toolName: string;
  input: unknown;
} & ({ status: "success"; output: unknown } | { status: "error"; error: string });

/**
 * Normalizes the provider SDK's split tool-call/result representation into one
 * outcome per actual call. Pairing is scoped to one SDK step and uses call IDs
 * internally. Orphan result/error parts are ignored because the public output
 * is call-centric; tool failures attached to calls still fail closed.
 */
export function agentToolOutcomes(
  result: Pick<AgentTextRunResult, "toolCalls" | "toolResults" | "steps">,
): AgentToolOutcome[] {
  const steps =
    result.steps.length > 0
      ? result.steps
      : [
          {
            toolCalls: result.toolCalls,
            toolResults: result.toolResults,
          },
        ];
  return steps.flatMap((step) => normalizeStepToolOutcomes(step));
}

export type AgentFoundationIssue = {
  path: string;
  code: string;
  message: string;
};

export type AgentFoundationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: AgentFoundationIssue[] };

export type JsonSchema =
  | boolean
  | {
      readonly [key: string]: JsonSchemaValue;
    };

export type JsonSchemaValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonSchemaValue[]
  | {
      readonly [key: string]: JsonSchemaValue;
    };

export type AgentClarificationChoice = {
  id: string;
  label: string;
  intent: "primary" | "default" | "secondary";
  // A choice that carries no answer by itself, and is only a way to open the
  // free-text composer. Questions whose answer is inherently prose rather than
  // a selection have no meaningful choices to offer, so their host synthesizes
  // a single choice to satisfy the choice-driven surface; picking it without
  // text would submit an answer that says nothing.
  requiresFollowUp?: boolean;
};

export type AgentClarificationRequest = {
  headline: string;
  reasoning: string | null;
  sampleValues: readonly string[] | null;
  choices: readonly AgentClarificationChoice[];
  canAskFollowUp: boolean;
  targetModel: ModelId | null;
  targetField: FieldId | null;
  /** Integer count; matches the `{ type: "integer" }` JSON schema constraint. */
  totalQuestions: number | null;
};

export type AgentClarificationResult =
  | { answered: true; choiceId: string; followUp: string | null; error: null }
  | { answered: false; choiceId: null; followUp: null; error: string };

export type AgentToolCapability = "read_only" | "proposal" | "write";

export type AgentToolDefinition = {
  id: string;
  label: string;
  description: string;
  groupId: AgentToolGroupId;
  capability: AgentToolCapability;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export function createOpenAiStrictObjectSchema(
  properties: Readonly<Record<string, JsonSchemaValue>>,
): JsonSchema {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// `AgentClarificationChoice.requiresFollowUp` is deliberately absent here, and
// the omission is not a drift. This schema is the model's output contract, and
// `requiresFollowUp` is synthesized by the host after the model has answered --
// it marks a choice the host invented to open the composer, which is a fact
// about the surface rather than about the clarification. Adding it would tell
// the model it may emit the key, and a model-set `requiresFollowUp` would mean
// nothing to the host that has to honour it.
export const AGENT_CLARIFICATION_CHOICE_JSON_SCHEMA = {
  type: "object",
  description:
    "A complete, self-contained answer choice. Only offer choices when selecting one choice fully answers the clarification; if the user must supply free text or additional data, provide no choices.",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    intent: { type: "string", enum: ["primary", "default", "secondary"] },
  },
  required: ["id", "label", "intent"],
  additionalProperties: false,
} satisfies JsonSchema;

export const AGENT_CLARIFICATION_REQUEST_JSON_SCHEMA = createOpenAiStrictObjectSchema({
  headline: { type: "string" },
  reasoning: { anyOf: [{ type: "string" }, { type: "null" }] },
  sampleValues: {
    anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
  },
  choices: {
    type: "array",
    description:
      "Complete, self-contained answer choices only. Leave empty when the user needs to provide free text or any additional data.",
    items: AGENT_CLARIFICATION_CHOICE_JSON_SCHEMA,
  },
  canAskFollowUp: { type: "boolean" },
  targetModel: { anyOf: [{ type: "string" }, { type: "null" }] },
  targetField: { anyOf: [{ type: "string" }, { type: "null" }] },
  totalQuestions: { anyOf: [{ type: "integer" }, { type: "null" }] },
});

export const AGENT_CLARIFICATION_RESULT_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    answered: { type: "boolean" },
    choiceId: { anyOf: [{ type: "string" }, { type: "null" }] },
    followUp: { anyOf: [{ type: "string" }, { type: "null" }] },
    error: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["answered", "choiceId", "followUp", "error"],
  additionalProperties: false,
  anyOf: [
    createOpenAiStrictObjectSchema({
      answered: { const: true },
      choiceId: { type: "string" },
      followUp: { anyOf: [{ type: "string" }, { type: "null" }] },
      error: { type: "null" },
    }),
    createOpenAiStrictObjectSchema({
      answered: { const: false },
      choiceId: { type: "null" },
      followUp: { type: "null" },
      error: { type: "string" },
    }),
  ],
};

export async function runAgentText(request: AgentTextRunRequest): Promise<AgentTextRunResult> {
  const issues = validateAgentExecutionProfile(request.identity, request.executionProfile);
  validateAgentIdentityMetadata(request.identity, "identity", issues);
  validateNonEmpty("runId", request.runId, "run id must not be empty", issues);
  validateBudget(request.identity.budget, "identity.budget", issues);
  if (issues.length > 0) {
    throw new AgentFoundationError(issues);
  }
  const budget = resolveBudget(request.identity.budget, request.executionProfile.budget);
  const grantedTools = agentGrantedTools(request.executionProfile, request.tools);
  const ai = await loadAiModule();
  const model = request.model ?? (await modelPolicyToAiSdkModel(request.executionProfile.model));
  const result = await ai.generateText(agentTextOptions(ai, request, model, grantedTools, budget));
  const structuredResult = result as typeof result & { output?: unknown };
  const steps = result.steps.map(agentTextStep);
  const finalStep = steps.at(-1);
  const executedProvider = finalStep?.provider ?? request.executionProfile.model.provider;
  const executedModel = finalStep?.model ?? request.executionProfile.model.model;
  return {
    text: result.text,
    ...(structuredResult.output === undefined ? {} : { output: structuredResult.output }),
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    steps,
    metadata: {
      runId: request.runId,
      identityId: request.identity.id,
      executionProfileId: request.executionProfile.id,
      provider: executedProvider,
      model: executedModel,
      inputTokens: result.totalUsage.inputTokens,
      outputTokens: result.totalUsage.outputTokens,
      toolSurface: grantedTools.map((runtimeTool) => runtimeTool.definition.id),
      finishReason: result.finishReason,
    },
  };
}

export async function runAgentTextStream(
  request: AgentTextRunRequest,
  callbacks: AgentTextStreamCallbacks = {},
): Promise<AgentTextRunResult> {
  const issues = validateAgentExecutionProfile(request.identity, request.executionProfile);
  validateAgentIdentityMetadata(request.identity, "identity", issues);
  validateNonEmpty("runId", request.runId, "run id must not be empty", issues);
  validateBudget(request.identity.budget, "identity.budget", issues);
  if (issues.length > 0) {
    throw new AgentFoundationError(issues);
  }
  const budget = resolveBudget(request.identity.budget, request.executionProfile.budget);
  const grantedTools = agentGrantedTools(request.executionProfile, request.tools);
  const ai = await loadAiModule();
  const model = request.model ?? (await modelPolicyToAiSdkModel(request.executionProfile.model));
  let streamAbortNotified = false;
  let streamInterrupted = false;
  let callbackError: unknown;
  const emitCallbackEvent = async (event: AgentTextStreamEvent) => {
    if (callbackError !== undefined) return;
    try {
      await callbacks.onEvent?.(event);
    } catch (error) {
      callbackError = error;
    }
  };
  const result = ai.streamText({
    ...agentTextOptions(ai, request, model, grantedTools, budget),
    onToolExecutionStart: async (event: unknown) => {
      await emitCallbackEvent(toolStreamEvent("tool_start", event));
    },
    onToolExecutionEnd: async (event: unknown) => {
      await emitCallbackEvent(toolStreamEvent("tool_end", event));
    },
    onAbort: async () => {
      streamAbortNotified = true;
      await callbacks.onAbort?.();
    },
  });
  let text = "";
  let textStreamError: unknown;
  try {
    for await (const delta of result.textStream) {
      text += delta;
      await emitCallbackEvent({ type: "text_delta", delta });
      if (callbackError !== undefined) break;
    }
  } catch (error) {
    if (isAbortError(error)) streamInterrupted = true;
    textStreamError = error;
  }
  const [stepsRaw, toolCalls, toolResults, finishReason, totalUsage, output] =
    await completedResult(
      [
        result.steps,
        result.toolCalls,
        result.toolResults,
        result.finishReason,
        result.totalUsage,
        request.output === undefined ? Promise.resolve(undefined) : result.output,
      ] as const,
      streamAbortNotified ? abortError() : (textStreamError ?? callbackError),
    );
  if (streamInterrupted) {
    throw abortError();
  }
  if (textStreamError && !isAbortError(textStreamError)) {
    throw textStreamError;
  }
  if (callbackError !== undefined) {
    throw callbackError;
  }
  const steps = stepsRaw.map(agentTextStep);
  const finalStep = steps.at(-1);
  const executedProvider = finalStep?.provider ?? request.executionProfile.model.provider;
  const executedModel = finalStep?.model ?? request.executionProfile.model.model;
  return {
    text,
    ...(output === undefined ? {} : { output }),
    toolCalls,
    toolResults,
    steps,
    metadata: {
      runId: request.runId,
      identityId: request.identity.id,
      executionProfileId: request.executionProfile.id,
      provider: executedProvider,
      model: executedModel,
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      toolSurface: grantedTools.map((runtimeTool) => runtimeTool.definition.id),
      finishReason,
    },
  };
}

async function completedResult<T extends readonly unknown[]>(
  promises: { [K in keyof T]: PromiseLike<T[K]> },
  textStreamError: unknown,
): Promise<T> {
  const settled = await Promise.allSettled(promises);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw textStreamError ?? rejected.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("aborted", "AbortError");
  }
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

export function isAbortError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function agentTextOptions(
  ai: Pick<AiModule, "jsonSchema" | "tool" | "stepCountIs">,
  request: AgentTextRunRequest,
  model: LanguageModel,
  grantedTools: readonly AgentRuntimeTool[],
  budget: AgentBudgetPolicy,
): GenerateTextOptions & StreamTextOptions {
  return {
    model,
    system: request.identity.baseInstructions,
    ...(request.messages === undefined
      ? { prompt: request.prompt }
      : { messages: request.messages }),
    temperature: request.executionProfile.model.temperature,
    maxRetries: request.executionProfile.retryLimit,
    timeout: budget.maxWallTimeMs,
    abortSignal: request.abortSignal,
    ...(grantedTools.length === 0
      ? {}
      : { stopWhen: ai.stepCountIs(request.executionProfile.maxSteps!) }),
    tools: createAiSdkToolSet(ai, grantedTools),
    ...(request.output === undefined ? {} : { output: request.output }),
  };
}

function agentTextStep(step: {
  stepNumber: number;
  model: { provider: string; modelId: string };
  usage: LanguageModelUsage;
  finishReason?: string;
  toolCalls: readonly unknown[];
  toolResults: readonly unknown[];
  content?: readonly unknown[];
}): AgentTextRunStep {
  return {
    stepNumber: step.stepNumber,
    provider: step.model.provider,
    model: step.model.modelId,
    inputTokens: step.usage.inputTokens,
    outputTokens: step.usage.outputTokens,
    finishReason: step.finishReason,
    toolCalls: step.toolCalls,
    toolResults: step.toolResults,
    // Raw content parts ride along: thrown tool errors exist ONLY as
    // `tool-error` parts here (the SDK excludes them from `toolResults`),
    // and correct call↔result pairing downstream needs to see them.
    content: step.content,
  };
}

function normalizeStepToolOutcomes(step: {
  toolCalls: readonly unknown[];
  toolResults: readonly unknown[];
  content?: readonly unknown[];
}): AgentToolOutcome[] {
  const callCounts = new Map<string, number>();
  for (const call of step.toolCalls) {
    const callId = toolPartString(call, "toolCallId");
    if (callId) callCounts.set(callId, (callCounts.get(callId) ?? 0) + 1);
  }

  const resultsByCallId = new Map<string, unknown[]>();
  for (const result of step.toolResults) {
    const callId = toolPartString(result, "toolCallId");
    if (callId && callCounts.has(callId)) appendToolPart(resultsByCallId, callId, result);
  }

  const errorsByCallId = new Map<string, unknown[]>();
  for (const part of step.content ?? []) {
    if (!isRecord(part) || part.type !== "tool-error") continue;
    const callId = toolPartString(part, "toolCallId");
    if (callId && callCounts.has(callId)) appendToolPart(errorsByCallId, callId, part);
  }

  return step.toolCalls.map((call) => {
    const callId = toolPartString(call, "toolCallId");
    const toolName = toolPartString(call, "toolName") ?? "unknown_tool";
    const input = toolCallInput(call);
    if (!callId) {
      return {
        toolName,
        input,
        status: "error" as const,
        error: "tool call is missing its identity",
      };
    }
    const results = resultsByCallId.get(callId) ?? [];
    const errors = errorsByCallId.get(callId) ?? [];
    const ambiguity = toolOutcomeAmbiguity(callCounts.get(callId) ?? 0, results, errors);
    if (ambiguity) {
      return {
        toolName,
        input,
        status: "error" as const,
        error: ambiguity,
      };
    }
    if (errors.length === 1) {
      return {
        toolName,
        input,
        status: "error" as const,
        error: toolErrorPartMessage(errors[0]),
      };
    }
    const result = results[0];
    if (result === undefined) {
      return {
        toolName,
        input,
        status: "error" as const,
        error: "tool call produced no result",
      };
    }
    return {
      toolName,
      input,
      status: "success" as const,
      output: toolResultOutput(result),
    };
  });
}

function appendToolPart(parts: Map<string, unknown[]>, callId: string, part: unknown): void {
  const existing = parts.get(callId);
  if (existing) existing.push(part);
  else parts.set(callId, [part]);
}

function toolOutcomeAmbiguity(
  callCount: number,
  results: readonly unknown[],
  errors: readonly unknown[],
): string | null {
  if (callCount > 1) return "tool call identity is duplicated";
  if (results.length > 1) return "tool call has duplicate results";
  if (errors.length > 1) return "tool call has duplicate errors";
  if (results.length === 1 && errors.length === 1) {
    return "tool call has conflicting result and error outcomes";
  }
  return null;
}

function toolPartString(value: unknown, key: "toolCallId" | "toolName"): string | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function toolCallInput(call: unknown): unknown {
  if (!isRecord(call)) return null;
  for (const key of ["input", "args", "arguments"] as const) {
    if (!Object.hasOwn(call, key)) continue;
    const value = call[key];
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }
    return value;
  }
  return null;
}

function toolResultOutput(result: unknown): unknown {
  if (!isRecord(result)) return result;
  if (Object.hasOwn(result, "output")) return result.output;
  if (Object.hasOwn(result, "result")) return result.result;
  return result;
}

function toolErrorPartMessage(part: unknown): string {
  const error = isRecord(part) ? part.error : undefined;
  if (error instanceof Error) return error.message || "tool call failed";
  if (typeof error === "string") return error || "tool call failed";
  if (isRecord(error) && typeof error.message === "string") {
    return error.message || "tool call failed";
  }
  if (error == null) return "tool call failed";
  try {
    return JSON.stringify(error) ?? "tool call failed";
  } catch {
    return "tool call failed";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toolStreamEvent(type: "tool_start" | "tool_end", event: unknown): AgentTextStreamEvent {
  const toolCall =
    event != null && typeof event === "object"
      ? (event as { toolCall?: unknown }).toolCall
      : undefined;
  const callRecord =
    toolCall != null && typeof toolCall === "object"
      ? (toolCall as { toolCallId?: unknown; toolName?: unknown })
      : undefined;
  const callId =
    typeof callRecord?.toolCallId === "string" && callRecord.toolCallId.length > 0
      ? callRecord.toolCallId
      : "unknown_tool_call";
  const toolName =
    typeof callRecord?.toolName === "string" && callRecord.toolName.length > 0
      ? callRecord.toolName
      : "unknown_tool";
  if (type === "tool_start") return { type, callId, toolName };
  const output =
    event != null && typeof event === "object"
      ? (event as { toolOutput?: { type?: unknown } }).toolOutput
      : undefined;
  return {
    type,
    callId,
    toolName,
    status: output?.type === "tool-error" ? "error" : "done",
  };
}

export function validateAgentIdentity(
  identity: AgentIdentity,
  profiles: readonly AgentExecutionProfile[],
): AgentFoundationIssue[] {
  const issues: AgentFoundationIssue[] = [];
  validateAgentIdentityMetadata(identity, "", issues);
  const defaultProfile = profiles.find(
    (candidate) => candidate.id === identity.defaultExecutionProfile,
  );
  if (!defaultProfile) {
    issues.push(
      issue("defaultExecutionProfile", "unknown_profile", "Default profile is not defined"),
    );
  }
  validateBudget(identity.budget, "budget", issues);
  for (const profile of profiles) {
    issues.push(...validateAgentExecutionProfile(identity, profile, `profiles.${profile.id}`));
  }
  return issues;
}

export function validateAgentExecutionProfile(
  identity: AgentIdentity,
  profile: AgentExecutionProfile,
  path = "executionProfile",
): AgentFoundationIssue[] {
  const issues: AgentFoundationIssue[] = [];
  validateNonEmpty(`${path}.id`, profile.id, "profile id must not be empty", issues);
  validateNonEmpty(`${path}.label`, profile.label, "profile label must not be empty", issues);
  const requiresMaxSteps = profile.toolGroups.length > 0;
  if (
    (requiresMaxSteps || profile.maxSteps !== undefined) &&
    (!Number.isInteger(profile.maxSteps) || profile.maxSteps! < 1)
  ) {
    issues.push(
      issue(
        `${path}.maxSteps`,
        "invalid_limit",
        "tool-enabled profiles require a positive maxSteps",
      ),
    );
  }
  if (!Number.isInteger(profile.retryLimit) || profile.retryLimit < 0) {
    issues.push(
      issue(`${path}.retryLimit`, "invalid_limit", "retryLimit must be a non-negative integer"),
    );
  }
  if (profile.model.provider.trim().length === 0) {
    issues.push(
      issue(`${path}.model.provider`, "invalid_model_policy", "model provider must not be empty"),
    );
  } else if (profile.model.provider.includes("/")) {
    issues.push(
      issue(
        `${path}.model.provider`,
        "invalid_model_policy",
        "model provider must not contain `/`",
      ),
    );
  }
  if (profile.model.model.trim().length === 0) {
    issues.push(issue(`${path}.model.model`, "invalid_model_policy", "model id must not be empty"));
  } else if (profile.model.model.includes("/")) {
    issues.push(
      issue(`${path}.model.model`, "invalid_model_policy", "model id must not contain `/`"),
    );
  }
  if (profile.model.temperature != null && !Number.isFinite(profile.model.temperature)) {
    issues.push(
      issue(
        `${path}.model.temperature`,
        "invalid_model_policy",
        "model temperature must be finite",
      ),
    );
  }
  validateBudget(profile.budget, `${path}.budget`, issues);
  const allowedToolGroups = new Set(identity.allowedToolGroups);
  profile.toolGroups.forEach((toolGroup, index) => {
    if (toolGroup.trim().length === 0) {
      issues.push(
        issue(`${path}.toolGroups.${index}`, "empty_tool_group", "tool group id must not be empty"),
      );
      return;
    }
    if (!allowedToolGroups.has(toolGroup)) {
      issues.push(
        issue(
          `${path}.toolGroups`,
          "ungranted_tool_group",
          `Profile tool group \`${toolGroup}\` is not allowed by the identity`,
        ),
      );
    }
  });
  return issues;
}

export function validateOpenAiStrictJsonSchema(
  schema: JsonSchema,
  path = "schema",
): AgentFoundationIssue[] {
  const issues: AgentFoundationIssue[] = [];
  if (
    schema === true ||
    schema === false ||
    schema == null ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    issues.push(
      issue(
        path,
        "openai_strict_root_object",
        "OpenAI strict schemas must use an object schema at the root",
      ),
    );
    return issues;
  }
  if (schema["type"] !== "object") {
    issues.push(
      issue(
        `${path}.type`,
        "openai_strict_root_object",
        "OpenAI strict schemas must use type `object` at the root",
      ),
    );
  }
  validateOpenAiStrictSchemaNode(schema, path, issues);
  return issues;
}

export class AgentFoundationError extends Error {
  constructor(public readonly issues: readonly AgentFoundationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "AgentFoundationError";
  }
}

export type AgentExecutionCancellation = { cause: "deadline" } | { cause: "caller_abort" };

// Node and Bun coerce larger timer delays to an effectively immediate timer.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AgentExecutionDeadline {
  readonly abortSignal: AbortSignal;
  termination(): AgentExecutionCancellation | undefined;
  dispose(): void;
}

class ExecutionDeadline implements AgentExecutionDeadline {
  readonly #controller = new AbortController();
  readonly #callerSignal: AbortSignal | undefined;
  readonly #deadlineAtMs: number | undefined;
  readonly #onCallerAbort = () => {
    this.#finish(this.#deadlineElapsed() ? { cause: "deadline" } : { cause: "caller_abort" });
  };
  #deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  #termination: AgentExecutionCancellation | undefined;

  constructor(maxWallTimeMs?: number, callerSignal?: AbortSignal) {
    this.#callerSignal = callerSignal;
    this.#deadlineAtMs = maxWallTimeMs === undefined ? undefined : Date.now() + maxWallTimeMs;

    if (this.#callerSignal?.aborted) this.#finish({ cause: "caller_abort" });
    else this.#callerSignal?.addEventListener("abort", this.#onCallerAbort, { once: true });

    if (this.#termination === undefined && maxWallTimeMs !== undefined) {
      if (maxWallTimeMs === 0) this.#finish({ cause: "deadline" });
      else {
        this.#deadlineTimer = setTimeout(() => this.#finish({ cause: "deadline" }), maxWallTimeMs);
        (this.#deadlineTimer as { unref?: () => void }).unref?.();
      }
    }
  }

  get abortSignal(): AbortSignal {
    return this.#controller.signal;
  }

  termination(): AgentExecutionCancellation | undefined {
    if (this.#termination) return this.#termination;
    if (this.#deadlineElapsed()) return this.#finish({ cause: "deadline" });
    if (this.#callerSignal?.aborted) return this.#finish({ cause: "caller_abort" });
    return undefined;
  }

  dispose(): void {
    if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    this.#callerSignal?.removeEventListener("abort", this.#onCallerAbort);
  }

  #deadlineElapsed(): boolean {
    return this.#deadlineAtMs !== undefined && Date.now() >= this.#deadlineAtMs;
  }

  #finish(termination: AgentExecutionCancellation): AgentExecutionCancellation {
    if (this.#termination) return this.#termination;
    this.#termination = termination;
    if (this.#deadlineTimer !== undefined) clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    this.#controller.abort();
    return termination;
  }
}

export function createAgentExecutionDeadline(input: {
  maxWallTimeMs?: number;
  callerAbortSignal?: AbortSignal;
}): AgentExecutionDeadline {
  const issues: AgentFoundationIssue[] = [];
  validateBudget({ maxWallTimeMs: input.maxWallTimeMs }, "deadline", issues);
  if (input.maxWallTimeMs !== undefined && input.maxWallTimeMs > MAX_TIMER_DELAY_MS) {
    issues.push(
      issue(
        "deadline.maxWallTimeMs",
        "invalid_budget",
        `maxWallTimeMs must not exceed ${MAX_TIMER_DELAY_MS} for AgentExecutionDeadline`,
      ),
    );
  }
  if (issues.length > 0) throw new AgentFoundationError(issues);
  return new ExecutionDeadline(input.maxWallTimeMs, input.callerAbortSignal);
}

export async function modelPolicyToAiSdkModel(policy: AgentModelPolicy): Promise<LanguageModel> {
  const ai = await loadAiModule();
  return ai.gateway(`${policy.provider}/${policy.model}`);
}

function createAiSdkToolSet(
  ai: Pick<AiModule, "jsonSchema" | "tool">,
  runtimeTools: readonly AgentRuntimeTool[],
) {
  return Object.fromEntries(
    runtimeTools.map((runtimeTool) => [
      runtimeTool.definition.id,
      ai.tool({
        description: runtimeTool.definition.description,
        inputSchema: ai.jsonSchema(runtimeTool.definition.inputSchema as AiJsonSchema),
        execute: (input: unknown, options) => runtimeTool.execute(input, options),
      }),
    ]),
  );
}

function resolveBudget(identity: AgentBudgetPolicy, profile: AgentBudgetPolicy): AgentBudgetPolicy {
  return {
    maxWallTimeMs: stricterLimit(identity.maxWallTimeMs, profile.maxWallTimeMs),
  };
}

let aiModulePromise: Promise<AiModule> | null = null;

function loadAiModule(): Promise<AiModule> {
  aiModulePromise ??= import("ai");
  return aiModulePromise;
}

function stricterLimit(
  identityLimit: number | undefined,
  profileLimit: number | undefined,
): number | undefined {
  if (identityLimit == null) return profileLimit;
  if (profileLimit == null) return identityLimit;
  return Math.min(identityLimit, profileLimit);
}

function validateOpenAiStrictSchemaNode(
  schema: JsonSchemaValue,
  path: string,
  issues: AgentFoundationIssue[],
): void {
  if (schema == null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) =>
      validateOpenAiStrictSchemaNode(entry, `${path}[${index}]`, issues),
    );
    return;
  }
  const node = schema as Record<string, JsonSchemaValue>;
  if (node["type"] === "array") {
    const items = node["items"];
    if (!Object.hasOwn(node, "items")) {
      issues.push(
        issue(
          `${path}.items`,
          "missing_array_items",
          "OpenAI strict array schemas must declare items",
        ),
      );
    } else if (items == null || typeof items !== "object" || Array.isArray(items)) {
      issues.push(
        issue(
          `${path}.items.type`,
          "missing_array_item_type",
          "OpenAI strict array item schemas must declare a type",
        ),
      );
    } else {
      const itemNode = items as Record<string, JsonSchemaValue>;
      if (
        itemNode["type"] == null &&
        itemNode["anyOf"] == null &&
        itemNode["oneOf"] == null &&
        itemNode["allOf"] == null
      ) {
        issues.push(
          issue(
            `${path}.items.type`,
            "missing_array_item_type",
            "OpenAI strict array item schemas must declare a type or composition",
          ),
        );
      }
    }
  }
  if (node["type"] === "object" || node["properties"] != null) {
    const properties = node["properties"];
    if (properties == null || typeof properties !== "object" || Array.isArray(properties)) {
      issues.push(
        issue(
          `${path}.properties`,
          "missing_object_properties",
          "object schemas must declare properties",
        ),
      );
    } else {
      const propertyNames = Object.keys(properties as Record<string, JsonSchemaValue>);
      if (node["additionalProperties"] !== false) {
        issues.push(
          issue(
            `${path}.additionalProperties`,
            "openai_strict_additional_properties",
            "OpenAI strict object schemas must set additionalProperties to false",
          ),
        );
      }
      const required = node["required"];
      if (!Array.isArray(required) || !required.every((entry) => typeof entry === "string")) {
        issues.push(
          issue(
            `${path}.required`,
            "openai_strict_required",
            "OpenAI strict object schemas must require every declared property",
          ),
        );
      } else {
        const requiredSet = new Set(required);
        const propertyNameSet = new Set(propertyNames);
        const missing = propertyNames.filter((propertyName) => !requiredSet.has(propertyName));
        const unknown = required.filter((propertyName) => !propertyNameSet.has(propertyName));
        if (missing.length > 0 || unknown.length > 0) {
          issues.push(
            issue(
              `${path}.required`,
              "openai_strict_required",
              "OpenAI strict object schema required keys must exactly match properties",
            ),
          );
        }
      }
      for (const [propertyName, propertySchema] of Object.entries(
        properties as Record<string, JsonSchemaValue>,
      )) {
        validateOpenAiStrictSchemaNode(
          propertySchema,
          `${path}.properties.${propertyName}`,
          issues,
        );
      }
    }
  }
  for (const key of ["items", "anyOf", "oneOf", "allOf"] as const) {
    const child = node[key];
    if (child !== undefined) {
      validateOpenAiStrictSchemaNode(child, `${path}.${key}`, issues);
    }
  }
}

function validateBudget(
  budget: AgentBudgetPolicy,
  path: string,
  issues: AgentFoundationIssue[],
): void {
  for (const [key, value] of Object.entries(budget)) {
    if (value != null && (!Number.isInteger(value) || value < 0)) {
      issues.push(
        issue(`${path}.${key}`, "invalid_budget", `${key} must be a non-negative integer`),
      );
    }
  }
}

function validateAgentIdentityMetadata(
  identity: AgentIdentity,
  path: string,
  issues: AgentFoundationIssue[],
): void {
  const prefix = path.length > 0 ? `${path}.` : "";
  validateNonEmpty(`${prefix}id`, identity.id, "identity id must not be empty", issues);
  validateNonEmpty(`${prefix}name`, identity.name, "identity name must not be empty", issues);
  validateNonEmpty(
    `${prefix}purpose`,
    identity.purpose,
    "identity purpose must not be empty",
    issues,
  );
  validateNonEmpty(
    `${prefix}baseInstructions`,
    identity.baseInstructions,
    "identity base instructions must not be empty",
    issues,
  );
  validateNonEmpty(
    `${prefix}defaultExecutionProfile`,
    identity.defaultExecutionProfile,
    "default execution profile must not be empty",
    issues,
  );
  identity.allowedToolGroups.forEach((toolGroup, index) => {
    if (toolGroup.trim().length === 0) {
      issues.push(
        issue(
          `${prefix}allowedToolGroups.${index}`,
          "empty_tool_group",
          "tool group id must not be empty",
        ),
      );
    }
  });
}

function validateNonEmpty(
  path: string,
  value: string,
  message: string,
  issues: AgentFoundationIssue[],
): void {
  if (value.trim().length === 0) {
    issues.push(issue(path, "empty_value", message));
  }
}

function issue(path: string, code: string, message: string): AgentFoundationIssue {
  return { path, code, message };
}
