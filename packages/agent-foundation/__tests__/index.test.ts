import {
  agentGrantedTools,
  AGENT_CLARIFICATION_REQUEST_JSON_SCHEMA,
  AGENT_CLARIFICATION_RESULT_JSON_SCHEMA,
  AgentFoundationError,
  agentToolOutcomes,
  createOpenAiStrictObjectSchema,
  isAbortError,
  modelPolicyToAiSdkModel,
  runAgentText,
  runAgentTextStream,
  validateAgentExecutionProfile,
  validateAgentIdentity,
  validateOpenAiStrictJsonSchema,
  type AgentExecutionProfile,
  type AgentIdentity,
  type AgentRuntimeTool,
} from "../index";

import nodeAssert from "node:assert/strict";
import { describe, it, vi } from "vite-plus/test";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: aiMocks.generateText, streamText: aiMocks.streamText };
});

function assert(condition: unknown, message: string): asserts condition {
  nodeAssert(condition, message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  nodeAssert.equal(actual, expected, message);
}

function toolCall(callId: string | undefined, toolName: string, input: unknown = {}) {
  return {
    type: "tool-call",
    ...(callId === undefined ? {} : { toolCallId: callId }),
    toolName,
    input,
  };
}

function toolResult(callId: string | undefined, toolName: string | undefined, output: unknown) {
  return {
    type: "tool-result",
    ...(callId === undefined ? {} : { toolCallId: callId }),
    ...(toolName === undefined ? {} : { toolName }),
    output,
  };
}

function toolError(
  callId: string | undefined,
  toolName: string | undefined,
  error: unknown = new Error("failed"),
) {
  return {
    type: "tool-error",
    ...(callId === undefined ? {} : { toolCallId: callId }),
    ...(toolName === undefined ? {} : { toolName }),
    error,
  };
}

async function testAgentFoundation() {
  const identity: AgentIdentity = {
    id: "csv-import-planner",
    name: "CSV import planner",
    purpose: "Plan a source artifact import",
    baseInstructions: "Use canonical ids.",
    allowedToolGroups: ["schema", "source"],
    defaultExecutionProfile: "planner",
    budget: { maxWallTimeMs: 60_000 },
  };
  const profile: AgentExecutionProfile = {
    id: "planner",
    label: "Planner",
    model: { provider: "openai", model: "gpt-5.5", temperature: 0 },
    maxSteps: 8,
    retryLimit: 1,
    toolGroups: ["schema"],
    budget: { maxWallTimeMs: 60_000 },
  };
  const runtimeTool = (id: string, groupId: string): AgentRuntimeTool => ({
    definition: {
      id,
      label: id,
      description: id,
      groupId,
      capability: "read_only",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
    execute: () => ({}),
  });
  nodeAssert.deepEqual(
    agentGrantedTools(profile, [
      runtimeTool("inspect-schema", "schema"),
      runtimeTool("inspect-source", "source"),
    ]).map((tool) => tool.definition.id),
    ["inspect-schema"],
    "execution-profile tool groups determine the actual granted tool surface",
  );
  const firstDuplicate = runtimeTool("inspect-schema", "schema");
  const lastDuplicate = runtimeTool("inspect-schema", "schema");
  nodeAssert.deepEqual(
    agentGrantedTools(profile, [firstDuplicate, lastDuplicate]),
    [lastDuplicate],
    "duplicate tool ids match the AI SDK keyed surface's last-definition-wins behavior",
  );
  assertEqual(
    validateAgentIdentity(identity, [profile]).length,
    0,
    "identity/profile grant passes",
  );
  const blankIdentityIssues = validateAgentIdentity(
    {
      ...identity,
      id: " ",
      name: "",
      purpose: "",
      baseInstructions: "",
      defaultExecutionProfile: "",
      allowedToolGroups: [""],
      budget: { maxWallTimeMs: 1.5 },
    },
    [profile],
  );
  assert(
    blankIdentityIssues.some((issue) => issue.path === "id" && issue.code === "empty_value"),
    "identity validation rejects blank identity ids",
  );
  assert(
    blankIdentityIssues.some((issue) => issue.path === "baseInstructions"),
    "identity validation rejects blank base instructions",
  );
  assert(
    blankIdentityIssues.some((issue) => issue.path === "budget.maxWallTimeMs"),
    "identity validation rejects fractional deadlines",
  );
  const verifierProfile: AgentExecutionProfile = {
    ...profile,
    id: "verifier",
    label: "Verifier",
    toolGroups: ["write"],
  };
  assert(
    validateAgentIdentity(identity, [profile, verifierProfile]).some(
      (issue) =>
        issue.code === "ungranted_tool_group" && issue.path === "profiles.verifier.toolGroups",
    ),
    "identity/profile validation rejects ungranted non-default profile groups",
  );
  const writerProfile: AgentExecutionProfile = {
    ...profile,
    id: "writer",
    label: "Writer",
    toolGroups: ["source"],
  };
  assertEqual(
    validateAgentExecutionProfile(identity, writerProfile).length,
    0,
    "active profile validation allows non-default granted profiles",
  );
  const nonFiniteProfile: AgentExecutionProfile = {
    ...profile,
    maxSteps: Number.POSITIVE_INFINITY,
    retryLimit: Number.NaN,
  };
  const nonFiniteIssues = validateAgentExecutionProfile(identity, nonFiniteProfile);
  assert(
    nonFiniteIssues.some((issue) => issue.path === "executionProfile.maxSteps"),
    "execution profile validation rejects non-finite maxSteps",
  );
  assert(
    nonFiniteIssues.some((issue) => issue.path === "executionProfile.retryLimit"),
    "execution profile validation rejects NaN retryLimit",
  );
  const { maxSteps: _omittedMaxSteps, ...profileWithoutMaxSteps } = profile;
  assertEqual(
    validateAgentExecutionProfile(identity, {
      ...profileWithoutMaxSteps,
      toolGroups: [],
    }).length,
    0,
    "tool-free profiles may omit maxSteps",
  );
  assert(
    validateAgentExecutionProfile(identity, profileWithoutMaxSteps).some(
      (issue) => issue.path === "executionProfile.maxSteps",
    ),
    "tool-enabled profiles require maxSteps",
  );
  assert(
    validateAgentExecutionProfile(identity, {
      ...profileWithoutMaxSteps,
      toolGroups: [],
      maxSteps: 0,
    }).some((issue) => issue.path === "executionProfile.maxSteps"),
    "tool-free profiles reject an invalid defined maxSteps",
  );
  const emptyModelIssues = validateAgentExecutionProfile(identity, {
    ...profile,
    model: { provider: "", model: " ", temperature: 0 },
  });
  assert(
    emptyModelIssues.some((issue) => issue.path === "executionProfile.model.provider"),
    "execution profile validation rejects empty model providers",
  );
  assert(
    emptyModelIssues.some((issue) => issue.path === "executionProfile.model.model"),
    "execution profile validation rejects empty model ids",
  );
  const slashModelIssues = validateAgentExecutionProfile(identity, {
    ...profile,
    model: { provider: "openai/gateway", model: "gpt-5/foo", temperature: 0 },
  });
  assert(
    slashModelIssues.some((issue) => issue.path === "executionProfile.model.provider"),
    "execution profile validation rejects provider ids containing slash",
  );
  assert(
    slashModelIssues.some((issue) => issue.path === "executionProfile.model.model"),
    "execution profile validation rejects model ids containing slash",
  );
  assert(
    validateAgentExecutionProfile(identity, {
      ...profile,
      model: { provider: "openai", model: "gpt-5.5", temperature: Number.NaN },
    }).some((issue) => issue.path === "executionProfile.model.temperature"),
    "execution profile validation rejects non-finite model temperature",
  );
  assert(
    validateAgentExecutionProfile(identity, {
      ...profile,
      budget: { maxWallTimeMs: 0.5 },
    }).some((issue) => issue.path === "executionProfile.budget.maxWallTimeMs"),
    "execution profile validation rejects fractional deadlines",
  );
  const gatewayModel = (await modelPolicyToAiSdkModel(profile.model)) as { modelId?: string };
  assertEqual(
    gatewayModel.modelId,
    "openai/gpt-5.5",
    "model policy resolves to an AI SDK gateway model",
  );
  try {
    await runAgentText({
      runId: "run_1",
      identity,
      executionProfile: verifierProfile,
      prompt: "This should fail before model execution.",
    });
    throw new Error("runAgentText validation error was not thrown");
  } catch (error) {
    assert(error instanceof AgentFoundationError, "runAgentText throws AgentFoundationError");
    assertEqual(
      error.issues[0]?.code,
      "ungranted_tool_group",
      "runAgentText preserves validation issues",
    );
  }
  try {
    await runAgentText({
      runId: "run_invalid_budget",
      identity: { ...identity, budget: { maxWallTimeMs: -1 } },
      executionProfile: profile,
      prompt: "This should fail before model execution.",
    });
    throw new Error("runAgentText identity budget validation error was not thrown");
  } catch (error) {
    assert(error instanceof AgentFoundationError, "runAgentText validates identity budget");
    assertEqual(
      error.issues[0]?.path,
      "identity.budget.maxWallTimeMs",
      "identity budget issue path",
    );
  }
  try {
    await runAgentText({
      runId: "run_invalid_identity",
      identity: { ...identity, id: "" },
      executionProfile: profile,
      prompt: "This should fail before model execution.",
    });
    throw new Error("runAgentText identity metadata validation error was not thrown");
  } catch (error) {
    assert(error instanceof AgentFoundationError, "runAgentText validates identity metadata");
    assertEqual(error.issues[0]?.path, "identity.id", "identity metadata issue path");
  }
  try {
    await runAgentText({
      runId: "",
      identity,
      executionProfile: profile,
      prompt: "This should fail before model execution.",
    });
    throw new Error("runAgentText run id validation error was not thrown");
  } catch (error) {
    assert(error instanceof AgentFoundationError, "runAgentText validates run ids");
    assertEqual(error.issues[0]?.path, "runId", "run id issue path");
  }
  const strictSchema = createOpenAiStrictObjectSchema({
    modelId: { type: "string" },
    fieldId: { anyOf: [{ type: "string" }, { type: "null" }] },
  });
  assertEqual(
    validateOpenAiStrictJsonSchema(strictSchema).length,
    0,
    "OpenAI strict object helper emits provider-compatible required/additionalProperties",
  );
  assertEqual(
    validateOpenAiStrictJsonSchema(AGENT_CLARIFICATION_REQUEST_JSON_SCHEMA).length,
    0,
    "clarification request schema satisfies OpenAI strict object requirements",
  );
  assert(
    JSON.stringify(AGENT_CLARIFICATION_REQUEST_JSON_SCHEMA).includes("self-contained answer"),
    "clarification request schema documents that choices are only for self-contained answers",
  );
  assertEqual(
    validateOpenAiStrictJsonSchema(AGENT_CLARIFICATION_RESULT_JSON_SCHEMA).length,
    0,
    "clarification result schema satisfies OpenAI strict object requirements",
  );
  const clarificationResultSchema = AGENT_CLARIFICATION_RESULT_JSON_SCHEMA as {
    anyOf?: readonly unknown[];
  };
  assertEqual(
    clarificationResultSchema.anyOf?.length,
    2,
    "clarification result schema keeps success/error branches tagged while remaining strict",
  );
  assert(
    validateOpenAiStrictJsonSchema({
      type: "object",
      properties: {
        requiredProperty: { type: "string" },
        optionalProperty: { type: "string" },
      },
      required: ["requiredProperty"],
      additionalProperties: false,
    }).some((issue) => issue.code === "openai_strict_required"),
    "OpenAI strict validation rejects object properties omitted from required",
  );
  assert(
    validateOpenAiStrictJsonSchema({
      type: "object",
      properties: { modelId: { type: "string" } },
      required: ["modelId"],
    }).some((issue) => issue.code === "openai_strict_additional_properties"),
    "OpenAI strict validation rejects object schemas without additionalProperties false",
  );
  assert(
    validateOpenAiStrictJsonSchema({
      type: "object",
      properties: {
        values: { type: "array", maxItems: 0 },
      },
      required: ["values"],
      additionalProperties: false,
    }).some((issue) => issue.code === "missing_array_items"),
    "OpenAI strict validation rejects array schemas without items",
  );
  assertEqual(
    validateOpenAiStrictJsonSchema({
      type: "object",
      properties: {
        values: { type: "array", items: { type: "string" }, maxItems: 0 },
      },
      required: ["values"],
      additionalProperties: false,
    }).length,
    0,
    "OpenAI strict validation accepts an explicitly typed empty array contract",
  );
  assert(
    validateOpenAiStrictJsonSchema({
      type: "object",
      properties: {
        values: { type: "array", items: {}, maxItems: 0 },
      },
      required: ["values"],
      additionalProperties: false,
    }).some((issue) => issue.code === "missing_array_item_type"),
    "OpenAI strict validation rejects untyped array items",
  );
  assert(
    validateOpenAiStrictJsonSchema({
      anyOf: [
        createOpenAiStrictObjectSchema({ ok: { const: true } }),
        createOpenAiStrictObjectSchema({ error: { type: "string" } }),
      ],
    }).some((issue) => issue.code === "openai_strict_root_object"),
    "OpenAI strict validation rejects non-object root schemas",
  );
  assert(isAbortError({ name: "AbortError" }), "abort detection accepts plain object errors");
  assert(!isAbortError({ name: "OtherError" }), "abort detection rejects non-abort names");
}

async function testAgentTextStreamCallbackErrors() {
  const identity: AgentIdentity = {
    id: "query-agent",
    name: "Query agent",
    purpose: "Answer questions",
    baseInstructions: "Answer from tools.",
    allowedToolGroups: ["read"],
    defaultExecutionProfile: "reader",
    budget: {},
  };
  const profile: AgentExecutionProfile = {
    id: "reader",
    label: "Reader",
    model: { provider: "test", model: "stream" },
    maxSteps: 2,
    retryLimit: 0,
    toolGroups: ["read"],
    budget: {},
  };
  const callbackError = new Error("subscriber failed");
  aiMocks.streamText.mockReset();
  aiMocks.streamText.mockReturnValueOnce({
    textStream: (async function* () {
      yield "hello";
    })(),
    steps: Promise.resolve([
      {
        stepNumber: 0,
        provider: "test",
        model: "stream",
        inputTokens: 1,
        outputTokens: 1,
        finishReason: "stop",
        toolCalls: [],
        toolResults: [],
      },
    ]),
    toolCalls: Promise.resolve([]),
    toolResults: Promise.resolve([]),
    finishReason: Promise.resolve("stop"),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    output: Promise.resolve(undefined),
  });

  try {
    await runAgentTextStream(
      {
        runId: "run_stream_callback_error",
        identity,
        executionProfile: profile,
        prompt: "Hello",
        model: {} as never,
      },
      {
        onEvent: () => {
          throw callbackError;
        },
      },
    );
    throw new Error("stream callback error was not thrown");
  } catch (error) {
    assertEqual(error, callbackError, "stream callback errors propagate as callback errors");
  }
}

async function testAgentTextStreamPreservesSettledToolResults() {
  const identity: AgentIdentity = {
    id: "query-agent",
    name: "Query agent",
    purpose: "Answer questions",
    baseInstructions: "Answer from tools.",
    allowedToolGroups: ["read"],
    defaultExecutionProfile: "reader",
    budget: {},
  };
  const profile: AgentExecutionProfile = {
    id: "reader",
    label: "Reader",
    model: { provider: "test", model: "stream" },
    maxSteps: 2,
    retryLimit: 0,
    toolGroups: ["read"],
    budget: {},
  };
  const toolCall = { type: "tool-call", toolName: "lookup", input: {} };
  const toolResult = { type: "tool-result", toolName: "lookup", output: { ok: true } };
  aiMocks.streamText.mockReset();
  aiMocks.streamText.mockReturnValueOnce({
    textStream: (async function* () {
      yield "partial";
    })(),
    steps: Promise.resolve([
      {
        stepNumber: 0,
        model: { provider: "test", modelId: "stream" },
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "tool-calls",
        toolCalls: [toolCall],
        toolResults: [toolResult],
      },
    ]),
    toolCalls: Promise.resolve([toolCall]),
    toolResults: Promise.resolve([toolResult]),
    finishReason: Promise.resolve("stop"),
    totalUsage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    output: Promise.resolve(undefined),
  });

  const result = await runAgentTextStream({
    runId: "run_stream_budget",
    identity,
    executionProfile: profile,
    prompt: "Hello",
    model: {} as never,
  });

  assertEqual(result.text, "partial", "stream result text is preserved at budget");
  assertEqual(result.toolCalls.length, 1, "stream result tool calls are preserved at budget");
}

async function testAgentTextPreservesSettledToolResults() {
  const identity: AgentIdentity = {
    id: "query-agent",
    name: "Query agent",
    purpose: "Answer questions",
    baseInstructions: "Answer from tools.",
    allowedToolGroups: ["read"],
    defaultExecutionProfile: "reader",
    budget: {},
  };
  const profile: AgentExecutionProfile = {
    id: "reader",
    label: "Reader",
    model: { provider: "test", model: "generate" },
    maxSteps: 2,
    retryLimit: 0,
    toolGroups: ["read"],
    budget: {},
  };
  const toolCall = { type: "tool-call", toolName: "lookup", input: {} };
  const toolResult = { type: "tool-result", toolName: "lookup", output: { ok: true } };
  aiMocks.generateText.mockReset();
  aiMocks.generateText.mockResolvedValueOnce({
    text: "partial",
    steps: [
      {
        stepNumber: 0,
        model: { provider: "test", modelId: "generate" },
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "tool-calls",
        toolCalls: [toolCall],
        toolResults: [toolResult],
      },
    ],
    toolCalls: [toolCall],
    toolResults: [toolResult],
    finishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1 },
  });

  const result = await runAgentText({
    runId: "run_generate_budget",
    identity,
    executionProfile: profile,
    prompt: "Hello",
    model: {} as never,
  });

  assertEqual(result.text, "partial", "generate result text is preserved at budget");
  assertEqual(result.toolCalls.length, 1, "generate result tool calls are preserved at budget");
}

async function testAgentTextPreservesOrdinaryResults() {
  const identity: AgentIdentity = {
    id: "query-agent",
    name: "Query agent",
    purpose: "Answer questions",
    baseInstructions: "Answer from tools.",
    allowedToolGroups: ["read"],
    defaultExecutionProfile: "reader",
    budget: {},
  };
  const profile: AgentExecutionProfile = {
    id: "reader",
    label: "Reader",
    model: { provider: "test", model: "generate" },
    maxSteps: 2,
    retryLimit: 0,
    toolGroups: ["read"],
    budget: {},
  };
  const toolCall = { type: "tool-call", toolName: "lookup", input: {} };
  const toolResult = { type: "tool-result", toolName: "lookup", output: { ok: true } };
  aiMocks.generateText.mockReset();
  aiMocks.generateText.mockResolvedValueOnce({
    text: "complete",
    steps: [
      {
        stepNumber: 0,
        model: { provider: "test", modelId: "generate" },
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "tool-calls",
        toolCalls: [toolCall],
        toolResults: [toolResult],
      },
    ],
    toolCalls: [toolCall],
    toolResults: [toolResult],
    finishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1 },
  });

  const result = await runAgentText({
    runId: "run_generate_below_budget",
    identity,
    executionProfile: profile,
    prompt: "Hello",
    model: {} as never,
  });

  assertEqual(result.text, "complete", "below-budget result text is preserved");
}

describe("agent foundation", () => {
  it("pairs successful results and thrown errors by call ID", () => {
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [toolCall("failed", "lookup"), toolCall("passed", "propose")],
          toolResults: [toolResult("passed", "redundant-result-name", { ok: true })],
          content: [toolError("failed", "redundant-error-name")],
        },
      ],
    });

    nodeAssert.deepEqual(outcomes, [
      { toolName: "lookup", input: {}, status: "error", error: "failed" },
      { toolName: "propose", input: {}, status: "success", output: { ok: true } },
    ]);
  });

  it("preserves supported alternate input and output fields", () => {
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [
            { type: "tool-call", toolCallId: "args", toolName: "lookup", args: { id: 1 } },
            {
              type: "tool-call",
              toolCallId: "arguments",
              toolName: "propose",
              arguments: '{"approved":true}',
            },
          ],
          toolResults: [
            { type: "tool-result", toolCallId: "args", result: { found: true } },
            { type: "tool-result", toolCallId: "arguments", output: { saved: true } },
          ],
        },
      ],
    });

    nodeAssert.deepEqual(outcomes, [
      {
        toolName: "lookup",
        input: { id: 1 },
        status: "success",
        output: { found: true },
      },
      {
        toolName: "propose",
        input: { approved: true },
        status: "success",
        output: { saved: true },
      },
    ]);
  });

  it("preserves explicitly undefined inputs and outputs", () => {
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [
            {
              type: "tool-call",
              toolCallId: "input",
              toolName: "input-void",
              input: undefined,
            },
            { type: "tool-call", toolCallId: "args", toolName: "args-void", args: undefined },
          ],
          toolResults: [
            toolResult("input", "input-void", undefined),
            { type: "tool-result", toolCallId: "args", result: undefined },
          ],
        },
      ],
    });

    nodeAssert.deepEqual(outcomes, [
      { toolName: "input-void", input: undefined, status: "success", output: undefined },
      { toolName: "args-void", input: undefined, status: "success", output: undefined },
    ]);
  });

  it("uses a stable fallback for empty tool-error messages", () => {
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [
            toolCall("error", "lookup"),
            toolCall("string", "lookup"),
            toolCall("record", "lookup"),
          ],
          toolResults: [],
          content: [
            toolError("error", "lookup", new Error("")),
            toolError("string", "lookup", ""),
            toolError("record", "lookup", { message: "" }),
          ],
        },
      ],
    });

    assert(
      outcomes.every(
        (outcome) => outcome.status === "error" && outcome.error === "tool call failed",
      ),
      "empty error messages use the stable fallback",
    );
  });

  it("pairs top-level tool arrays when the provider returns no steps", () => {
    nodeAssert.deepEqual(
      agentToolOutcomes({
        toolCalls: [toolCall("top-level", "lookup", { id: 1 })],
        toolResults: [toolResult("top-level", "lookup", { found: true })],
        steps: [],
      }),
      [
        {
          toolName: "lookup",
          input: { id: 1 },
          status: "success",
          output: { found: true },
        },
      ],
    );
  });

  it("preserves structured thrown values with a safe serialization fallback", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [toolCall("structured", "lookup"), toolCall("circular", "lookup")],
          toolResults: [],
          content: [
            toolError("structured", "lookup", { code: "not_found", retryable: false }),
            toolError("circular", "lookup", circular),
          ],
        },
      ],
    });

    nodeAssert.deepEqual(outcomes, [
      {
        toolName: "lookup",
        input: {},
        status: "error",
        error: '{"code":"not_found","retryable":false}',
      },
      { toolName: "lookup", input: {}, status: "error", error: "tool call failed" },
    ]);
  });

  it("fails only calls with malformed or ambiguous attached evidence", () => {
    const cases: {
      calls: unknown[];
      results: unknown[];
      errors: unknown[];
      expected: string;
    }[] = [
      {
        calls: [toolCall(undefined, "target")],
        results: [],
        errors: [],
        expected: "tool call is missing its identity",
      },
      {
        calls: [toolCall("target", "target")],
        results: [],
        errors: [],
        expected: "tool call produced no result",
      },
      {
        calls: [toolCall("target", "target"), toolCall("target", "target")],
        results: [toolResult("target", "target", true)],
        errors: [],
        expected: "tool call identity is duplicated",
      },
      {
        calls: [toolCall("target", "target")],
        results: [toolResult("target", "target", true), toolResult("target", "target", true)],
        errors: [],
        expected: "tool call has duplicate results",
      },
      {
        calls: [toolCall("target", "target")],
        results: [],
        errors: [toolError("target", "target"), toolError("target", "target")],
        expected: "tool call has duplicate errors",
      },
      {
        calls: [toolCall("target", "target")],
        results: [toolResult("target", "target", true)],
        errors: [toolError("target", "target")],
        expected: "tool call has conflicting result and error outcomes",
      },
    ];

    for (const testCase of cases) {
      const outcomes = agentToolOutcomes({
        toolCalls: [],
        toolResults: [],
        steps: [
          {
            stepNumber: 0,
            provider: "test",
            model: "test",
            toolCalls: [...testCase.calls, toolCall("valid", "valid")],
            toolResults: [...testCase.results, toolResult("valid", "valid", true)],
            content: testCase.errors,
          },
        ],
      });
      const targetOutcomes = outcomes.filter((outcome) => outcome.toolName === "target");
      assert(targetOutcomes.length > 0, "malformed fixture retains its actual call outcomes");
      assert(
        targetOutcomes.every(
          (outcome) => outcome.status === "error" && outcome.error === testCase.expected,
        ),
        `malformed call fails closed: ${testCase.expected}`,
      );
      nodeAssert.deepEqual(outcomes.at(-1), {
        toolName: "valid",
        input: {},
        status: "success",
        output: true,
      });
    }
  });

  it("ignores orphan evidence because normalized output is call-centric", () => {
    const outcomes = agentToolOutcomes({
      toolCalls: [],
      toolResults: [],
      steps: [
        {
          stepNumber: 0,
          provider: "test",
          model: "test",
          toolCalls: [toolCall("valid", "valid")],
          toolResults: [
            toolResult("valid", "valid", true),
            toolResult(undefined, "orphan", false),
            toolResult("unknown", "orphan", false),
          ],
          content: [toolError(undefined, "orphan"), toolError("unknown", "orphan")],
        },
      ],
    });

    nodeAssert.deepEqual(outcomes, [
      { toolName: "valid", input: {}, status: "success", output: true },
    ]);
  });

  it("scopes provider call IDs independently within each SDK step", () => {
    const step = (stepNumber: number, output: string) => ({
      stepNumber,
      provider: "test",
      model: "test",
      toolCalls: [toolCall("reused", "lookup", { stepNumber })],
      toolResults: [toolResult("reused", "lookup", output)],
    });

    nodeAssert.deepEqual(
      agentToolOutcomes({ toolCalls: [], toolResults: [], steps: [step(0, "a"), step(1, "b")] }),
      [
        { toolName: "lookup", input: { stepNumber: 0 }, status: "success", output: "a" },
        { toolName: "lookup", input: { stepNumber: 1 }, status: "success", output: "b" },
      ],
    );
  });

  it("validates foundation contracts", async () => {
    await testAgentFoundation();
  });

  it("keeps streaming callback errors separate from reader errors", async () => {
    await testAgentTextStreamCallbackErrors();
  });

  it("preserves settled streaming tool results", async () => {
    await testAgentTextStreamPreservesSettledToolResults();
  });

  it("preserves settled generated tool results", async () => {
    await testAgentTextPreservesSettledToolResults();
  });

  it("preserves ordinary generated results", async () => {
    await testAgentTextPreservesOrdinaryResults();
  });
});
