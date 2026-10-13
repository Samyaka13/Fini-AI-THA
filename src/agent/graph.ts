import { END, START, StateGraph } from "@langchain/langgraph";
import { MockStore } from "../data/mockStore.js";
import { newSession, type SupportSession } from "../domain/session.js";
import { mandatoryEscalation } from "../policy/escalationPolicy.js";
import { assessFraud } from "../policy/fraudPolicy.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { verifySession } from "../policy/verification.js";
import { SafeToolExecutor, type ToolTrace, type ToolName } from "../tools/registry.js";
import { escalateToHumanSchema, getCustomerSchema, getTransactionSchema, issueRefundSchema } from "../tools/schemas.js";
import { FIXED_NOW, ageInWholeDays } from "../utils/dates.js";
import { extractEmail, extractFraudAmount, extractLast4, extractRefundAmount, extractTransactionId, isAccountClosure, isFrozenCardRequest, isImmediateCancellation, isLegalAction, isRefundRequest } from "./routing.js";
import { OpenRouterClient, parseToolArguments, sanitizeForLlm, type LlmClient, type LlmMessage, type LlmToolCall } from "./openRouter.js";
import { AgentState, type AgentStateValue } from "./state.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_TOOL_ITERATIONS = 4;
const allowedTools = new Set<ToolName>(["get_customer", "get_transaction", "issue_refund", "escalate_to_human"]);
export interface TurnResult { response: string; session: SupportSession; traces: ToolTrace[]; llmToolCalls: string[]; llmError: string | null; }
export interface AgentOptions { store?: MockStore; now?: () => Date; llm?: LlmClient | null; }

export class PaylaneAgent {
  readonly store: MockStore; readonly executor: SafeToolExecutor; readonly graph; readonly systemPrompt = SYSTEM_PROMPT;
   private readonly llm: LlmClient | null; private session = newSession(); 
   private messages: LlmMessage[] = [];
   private trustedInput = "";
  constructor(options: AgentOptions = {}) { 
    this.store = options.store ?? new MockStore(); 
    this.executor = new SafeToolExecutor(this.store, options.now ?? (() => FIXED_NOW)); 
    this.llm = options.llm === undefined ? OpenRouterClient.fromEnvironment() : options.llm; 
    this.graph = new StateGraph(AgentState)
    .addNode("tool_cycle", (state) => this.runCycle(state))
    .addNode("record_response", (state) => ({ messages: [...state.messages, { role: "assistant", content: state.response }] }))
    .addEdge(START, "tool_cycle")
    .addEdge("tool_cycle", "record_response")
    .addEdge("record_response", END)
    .compile(); 
  }
  async respond(message: string): Promise<TurnResult> {
     this.trustedInput = message; 
     const start = this.executor.traces.length; 
     const state = await this.graph.invoke({ 
       messages: [...this.messages, { role: "user", content: message }],
       response: "", 
       session: this.session, 
       traces: [], 
       llmToolCalls: [], 
       llmError: null 
      }); 
      console.log("=== FINAL GRAPH STATE ===");
console.dir(state, { depth: null });
     this.messages = state.messages; 
     this.session = structuredClone(state.session); 
  return { 
    response: state.response, 
    session: structuredClone(state.session), 
    traces: this.executor.traces.slice(start), 
    llmToolCalls: state.llmToolCalls.map((call) => call.function.name), 
    llmError: state.llmError
  }; 
  }

  private async runCycle(state: AgentStateValue): Promise<Partial<AgentStateValue>> {
    console.log("=== TOOL_CYCLE: INPUT STATE ===");
    console.dir(state, { depth: null });
    if (!this.llm) return this.fallback(state, null);
    let messages = [...state.messages]; 
    let session = structuredClone(state.session); 
    const calls: LlmToolCall[] = []; 
    const traceStart = this.executor.traces.length;
    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const completion = await this.llm.complete(messages); 
        calls.push(...completion.toolCalls);
        messages = [...messages, { role: "assistant", content: completion.content, ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}) }];
        if (!completion.toolCalls.length) {
          const response = this.safeFinalResponse(completion.content, session, this.executor.traces.slice(traceStart));
          return {
            messages,
            response,
            session,
            traces: this.executor.traces,
            llmToolCalls: calls,
            llmError: null 
          };
        }
        const results = completion.toolCalls.map((call) => this.dispatchTool(call, session));
        session = results.at(-1)?.session ?? session;
        messages = [...messages, ...results.map(({ call, result }) => ({ role: "tool" as const, tool_call_id: call.id, content: JSON.stringify(result) }))];
      }
      return this.fallback({ ...state, messages, session, llmToolCalls: calls }, "The support assistant reached a safe processing limit.");
    } catch (error) { return this.fallback(state, error instanceof Error ? error.message : "LLM unavailable"); }
  }

  private dispatchTool(call: LlmToolCall, currentSession: SupportSession):
  { 
    call: LlmToolCall; 
    result: Record<string, unknown>;
    session: SupportSession 
  } 
  {
    const session = structuredClone(currentSession); 
    const args = parseToolArguments(call); 
    const raw = this.trustedInput;
    if (!allowedTools.has(call.function.name as ToolName) || !args) 
      return { call, session, result: { ok: false, error: "invalid_tool_request" 
    } 
  };
    const email = extractEmail(raw); 
    const last4 = extractLast4(raw); 
    const txnId = extractTransactionId(raw); 
    const refundAmount = extractRefundAmount(raw); 
    const fraud = assessFraud(raw, extractFraudAmount(raw));
    if (call.function.name === "get_customer") {
      if (!zString(args.email) || !email || !last4 || !getCustomerSchema.safeParse({ email }).success)
        return {
      call,
      session,
      result: { ok: false, verification: "missing_details" } 
    };
      const verification = verifySession(session, email, last4, this.executor.lookupForVerification(email));
      return { 
        call, 
        session: verification.session,
        result: { ok: verification.result === "verified", 
        verification: verification.result 
      }
    };
    }
    if (call.function.name === "get_transaction") {
      if (!getTransactionSchema.safeParse({ customer_id: session.customerId ?? "", txn_id: args.txn_id }).success || args.txn_id !== txnId) 
        return { call, session, result: { ok: false, error: "invalid_transaction_request" } };
      const found = this.executor.getOwnedTransaction(session, txnId!); 
      return { call, session, result: "transaction" in found ? { ok: true, transaction: found.transaction } : { ok: false, error: found.reason } };
    }
    if (call.function.name === "issue_refund") {
      if (!issueRefundSchema.safeParse(args).success || args.txn_id !== txnId || args.amount !== refundAmount) 
        return { call, session, result: { ok: false, error: "refund_arguments_must_match_customer_request" } };
      const result = this.executor.executeRefund(session, txnId!, refundAmount!, fraud.suspected); 
      return { call, session, result };
    }
    const summary = typeof args.summary === "string" ? args.summary.slice(0, 500) : "customer requested human support";
    const customerId = session.verified ? session.customerId : (email ? this.store.findCustomerByEmail(email)?.id ?? null : null);
    const ticket = this.executor.escalate(customerId, summary); return { call, session, result: { ok: true, ticket_id: ticket.ticket_id } };
  }

  private fallback(state: AgentStateValue, llmError: string | null): Partial<AgentStateValue> {
    const raw = this.trustedInput; 
    let session = structuredClone(state.session); 
    const email = extractEmail(raw) ?? session.suppliedEmail; 
    const last4 = extractLast4(raw) ?? session.suppliedCardLast4; 
    const refundAmount = extractRefundAmount(raw); 
    const fraudAmount = extractFraudAmount(raw); 
    const fraud = assessFraud(raw, fraudAmount); 
    const txnId = extractTransactionId(raw);
    const identityChanged = session.verified && ((extractEmail(raw) && extractEmail(raw)!.toLowerCase() !== (session.suppliedEmail ?? "").toLowerCase()) || (extractLast4(raw) && extractLast4(raw) !== session.suppliedCardLast4));
    const escalation = mandatoryEscalation(raw, { fraud: fraud.suspected, immediateFraud: fraud.immediate, legal: isLegalAction(raw), closure: isAccountClosure(raw) });
    if (escalation) { 
      const customerId = session.verified ? session.customerId : (extractEmail(raw) ? this.store.findCustomerByEmail(extractEmail(raw)!)?.id ?? null : null); 
      const ticket = this.executor.escalate(customerId, `${escalation}: customer request`); return this.finish(state, session, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).${escalation === "fraud_immediate" ? " I’ve marked it for immediate review." : ""}`,
         llmError
        ); 
      }
    if (identityChanged) return this.finish(state, session, "This support session is verified for a different account. Please start a new session to change account details.", 
      llmError
    );
    if (!session.verified) { 
      if (!email || !last4) 
        return this.finish(state, { ...session, suppliedEmail: email, suppliedCardLast4: last4 }, `To help with account or transaction requests, please provide ${!email ? "your account email" : "the last four digits of your card"}.`, llmError); 
      const verification = verifySession(session, email, last4, this.executor.lookupForVerification(email)); 
      session = verification.session; 
      if (verification.result !== "verified") return this.finish(state, session, "I couldn’t verify those details. Please check them and try again.", llmError); 
    }
    const customer = session.customerId ? this.store.findCustomerById(session.customerId) : undefined;
    if (customer?.status === "frozen" && isFrozenCardRequest(raw)) { 
      const ticket = this.executor.escalate(session.customerId, "frozen-card enquiry"); 
      return this.finish(state, session, `Your card is frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, 
        llmError); 
    }
    if (!isRefundRequest(raw)) return this.finish(state, session, "I can help with a refund, a card concern, or getting a specialist involved. What do you need?", llmError);
    if (!txnId) return this.finish(state, session, "Please share the transaction ID so I can look into the refund.", llmError); 
    if (refundAmount === undefined) return this.finish(state, session, "What refund amount are you requesting?", llmError);
    const found = this.executor.getOwnedTransaction(session, txnId); 
    if (!found.found) return this.finish(state, session, "I can’t find that transaction for this account.", llmError); 
    const transaction = this.store.findTransaction(txnId)!;
    const required = mandatoryEscalation(raw, { amount: refundAmount, ageDays: ageInWholeDays(transaction.date, this.executor.now()) ?? undefined, pendingUrgent: transaction.status === "pending" && isImmediateCancellation(raw), fraud: fraud.suspected, immediateFraud: fraud.immediate });
    if (required) { 
      const ticket = this.executor.escalate(session.customerId, `${required}: refund request`); 
      const explanation = required === "over_cap" ? "Refunds above $75 need a specialist." : required === "age" ? "Transactions 30 days old or older need a specialist." : "This request needs a specialist."; 
      return this.finish(state, session, `${explanation} I’ve sent it to the team (ticket ${ticket.ticket_id}).`, llmError); 
    }
    const decision = refundEligibility({ session, transaction, amount: refundAmount, now: this.executor.now(), suspectedFraud: fraud.suspected }); 
    if (!decision.eligible) return this.finish(state, session, decision.reason === "pending" ? "That transaction is still pending, so it can’t be refunded until it settles." : decision.reason === "already_refunded" ? "That transaction has already been refunded." : "I can’t complete that refund request.", llmError);
    const refund = this.executor.executeRefund(session, txnId, refundAmount, fraud.suspected); 
    return this.finish(state, session, refund.ok ? `Your $${refundAmount.toFixed(2)} refund has been issued (reference ${refund.refund_id}).` : "I couldn’t issue that refund. A specialist can help.", llmError);
  }
  private safeFinalResponse(content: string | null, session: SupportSession, traces: ToolTrace[]): string { 
    if (!content?.trim()) return this.fallback({ messages: [], response: "", session, traces: [], llmToolCalls: [], llmError: null }, null).response ?? "I need a little more information to help."; 
  const successfulRefund = traces.some((trace) => trace.tool === "issue_refund" && trace.result.ok === true);
  const successfulTicket = traces.some((trace) => trace.tool === "escalate_to_human" && typeof trace.result.ticket_id === "string"); 
  if (/(refund.*issued|ticket.*created|sent.*specialist)/i.test(content) && !successfulRefund && !successfulTicket){
    return "I can’t confirm that action yet. Please provide the requested details so I can continue.";
  }
  return content; 
}
  private finish(state: AgentStateValue, session: SupportSession, response: string, llmError: string | null): Partial<AgentStateValue> { return { messages: state.messages, session, response, traces: this.executor.traces, llmToolCalls: state.llmToolCalls, llmError }; }
}
function zString(value: unknown): value is string { return typeof value === "string"; }
