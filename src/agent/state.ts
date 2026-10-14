import { Annotation } from "@langchain/langgraph";
import type { SupportSession } from "../domain/session.js";
import type { ToolTrace } from "../tools/registry.js";
import type { LlmMessage, LlmToolCall } from "./openRouter.js";

export interface AgentStateValue {
  messages: LlmMessage[];
  response: string;
  session: SupportSession;
  traces: ToolTrace[];
  llmToolCalls: LlmToolCall[];
  llmError: string | null;
  /** Trusted per-turn input: never included in model-visible messages. */
  currentInput: string;
  /** Offset into executor traces at the start of this user turn. */
  traceStart: number;
}

export const AgentState = Annotation.Root({
  messages: Annotation<LlmMessage[]>({ reducer: (_, next) => next, default: () => [] }),
  response: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  session: Annotation<SupportSession>({ reducer: (_, next) => next, default: () => ({ verified: false, customerId: null, suppliedEmail: null, suppliedCardLast4: null, pendingRefund: null, loadedTransactionId: null, lastEscalation: null, pendingCardIntent: null }) }),
  traces: Annotation<ToolTrace[]>({ reducer: (_, next) => next, default: () => [] }),
  llmToolCalls: Annotation<LlmToolCall[]>({ reducer: (_, next) => next, default: () => [] }),
  llmError: Annotation<string | null>({ reducer: (_, next) => next, default: () => null }),
  currentInput: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  traceStart: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
});
