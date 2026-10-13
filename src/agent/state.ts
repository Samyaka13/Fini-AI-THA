import { Annotation } from "@langchain/langgraph";
import type { SupportSession } from "../domain/session.js";
import type { ToolTrace } from "../tools/registry.js";

export interface AgentStateValue {
  messages: string[];
  response: string;
  session: SupportSession;
  traces: ToolTrace[];
}

export const AgentState = Annotation.Root({
  messages: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  response: Annotation<string>({ reducer: (_, next) => next, default: () => "" }),
  session: Annotation<SupportSession>({ reducer: (_, next) => next, default: () => ({ verified: false, customerId: null, suppliedEmail: null, suppliedCardLast4: null }) }),
  traces: Annotation<ToolTrace[]>({ reducer: (_, next) => next, default: () => [] }),
});
