// agent-chat — a generic, app-agnostic conversation-surface module.
//
// Owns the chat leaves (message thread, composer, tool-call row, stage-changes
// affordance, grounding chip), built on assistant-ui headless primitives
// styled with core design tokens. Thin UI only: it renders conversation +
// accepts callbacks; it does NOT know app domain semantics (proposal schemas,
// grid-buffer internals, kernel verdicts, orchestration policy).
//
// Boundary: this package lives in `packages/modules/agent-chat/` and may
// import from `@autograph/components`, `@autograph/icons`, and external UI deps
// (`@assistant-ui/react`) only. App wiring (the runtime, the buffer, the
// anchor resolution) lives in the consuming app.

export type {
  AgentTurnResult,
  ChatAnchorView,
  ChatMessageView,
  ChatRole,
  ClarificationChoiceView,
  ClarificationView,
  MessagePartView,
  RunContinuationView,
  StageProposalView,
  TickerState,
  TickerStep,
  ToolCallStatus,
  ToolCallView,
} from "./types";

export { AnchorChip } from "./AnchorChip";
export type { AnchorChipProps } from "./AnchorChip";

export { ToolCallRow } from "./ToolCallRow";
export type { ToolCallRowProps } from "./ToolCallRow";

export { StatusTicker } from "./StatusTicker";
export type { StatusTickerProps } from "./StatusTicker";

export { StageConfirmation } from "./StageConfirmation";
export type { StageConfirmationLabels, StageConfirmationProps } from "./StageConfirmation";

export { MessageThread } from "./Message";
export type { MessageThreadProps } from "./Message";

export { PromptInput } from "./PromptInput";
export type { PromptInputProps } from "./PromptInput";

export { ClarificationCard } from "./ClarificationCard";
export type { ClarificationCardProps } from "./ClarificationCard";

export { AgentChatPanel } from "./AgentChatPanel";
export type { AgentChatPanelProps } from "./AgentChatPanel";

export { useAgentChatSession } from "./useAgentChatSession";
export type {
  AgentChatSessionActions,
  AgentChatSessionState,
  AgentRunRequest,
  RunAgent,
  RunAgentError,
  SessionErrorAction,
  SessionProposal,
  StageErrorAction,
  StageOutcome,
  TurnStreamEvent,
  TurnStreamHandle,
  UseAgentChatSessionConfig,
  UseAgentChatSessionResult,
} from "./useAgentChatSession";

export { ChatRuntimeProvider } from "./runtime";
export type { ChatRuntimeProviderProps } from "./runtime";
