import { END, START, StateGraph } from "@langchain/langgraph";
import { MockStore } from "../data/mockStore.js";
import { newSession, type SupportSession } from "../domain/session.js";
import { mandatoryEscalation } from "../policy/escalationPolicy.js";
import { assessFraud } from "../policy/fraudPolicy.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { verifySession } from "../policy/verification.js";
import { SafeToolExecutor, type ToolTrace } from "../tools/registry.js";
import { FIXED_NOW, ageInWholeDays } from "../utils/dates.js";
import { extractAmount, extractEmail, extractLast4, extractTransactionId, isFrozenCardRequest, isImmediateCancellation, isRefundRequest } from "./routing.js";
import { OpenRouterClient, sanitizeForLlm, type LlmClient, type LlmMessage } from "./openRouter.js";
import { AgentState, type AgentStateValue } from "./state.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export interface TurnResult { response: string; session: SupportSession; traces: ToolTrace[]; llmToolCalls: string[]; llmError: string | null; }
export interface AgentOptions { store?: MockStore; now?: () => Date; llm?: LlmClient | null; }

export class PaylaneAgent {
  readonly store: MockStore;
  readonly executor: SafeToolExecutor;
  readonly graph;
  readonly systemPrompt = SYSTEM_PROMPT;
  private readonly llm: LlmClient | null;
  private session = newSession();
  private messages: LlmMessage[] = [];
  constructor(options: AgentOptions = {}) {
    this.store = options.store ?? new MockStore();
    this.executor = new SafeToolExecutor(this.store, options.now ?? (() => FIXED_NOW));
    this.llm = options.llm === undefined ? OpenRouterClient.fromEnvironment() : options.llm;
    this.graph = new StateGraph(AgentState).addNode("llm", (state) => this.callLlm(state)).addNode("policy_and_tools", (state) => this.handle(state)).addNode("record_response", (state) => this.recordResponse(state)).addEdge(START, "llm").addEdge("llm", "policy_and_tools").addEdge("policy_and_tools", "record_response").addEdge("record_response", END).compile();
  }
  async respond(message: string): Promise<TurnResult> {
    const start = this.executor.traces.length;
    const state = await this.graph.invoke({ messages: [...this.messages, { role: "user", content: message }], response: "", session: this.session, traces: [], llmToolCalls: [], llmError: null });
    this.messages = state.messages; this.session = structuredClone(state.session);
    return { response: state.response, session: structuredClone(state.session), traces: this.executor.traces.slice(start), llmToolCalls: state.llmToolCalls.map((call) => call.name), llmError: state.llmError };
  }
  private async callLlm(state: AgentStateValue): Promise<Partial<AgentStateValue>> {
    if (!this.llm) return { llmToolCalls: [], llmError: null };
    try {
      const completion = await this.llm.complete(
        state.messages.map((message) =>
        ({
          ...message, content: sanitizeForLlm(message.content)
        }))
      );
      return {
        llmToolCalls: completion.toolCalls,
        llmError: null
      };
    }
    catch (error) { return { llmToolCalls: [], llmError: error instanceof Error ? error.message : "LLM unavailable" }; }
  }
  private handle(state: AgentStateValue): Partial<AgentStateValue> {
    const message = state.messages.at(-1)?.content ?? "";
    const givenEmail = extractEmail(message);
    const givenLast4 = extractLast4(message);
    const session = structuredClone(state.session);
    const identityChanged = session.verified && ((givenEmail !== null && givenEmail.toLowerCase() !== (session.suppliedEmail ?? "").toLowerCase()) || (givenLast4 !== null && givenLast4 !== session.suppliedCardLast4));
    const email = givenEmail ?? session.suppliedEmail;
    const last4 = givenLast4 ?? session.suppliedCardLast4;
    const amount = extractAmount(message);
    const transactionId = extractTransactionId(message);
    const fraud = assessFraud(message, amount);
    const escalationCustomerId = session.verified ? session.customerId : (givenEmail ? this.store.findCustomerByEmail(givenEmail)?.id ?? null : null);
    const escalation = mandatoryEscalation(message, { fraud: fraud.suspected, immediateFraud: fraud.immediate });
    if (escalation && (!isRefundRequest(message) || fraud.suspected || /legal|lawyer|attorney|sue|close.*account/i.test(message))) { const ticket = this.executor.escalate(escalationCustomerId, `${escalation}: customer request`); return this.result(state, session, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).${escalation === "fraud_immediate" ? " I’ve marked it for immediate review." : ""}`); }
    if (identityChanged) return this.result(state, session, "This support session is verified for a different account. Please start a new session to change account details.");
    if (!session.verified) {
      if (!email || !last4) { 
        const needed = !email && !last4 ? "your account email and the last four digits of your card" : !email ? "your account email" : "the last four digits of your card"; return this.result(state, { ...session, suppliedEmail: email, suppliedCardLast4: last4 }, `To help with account or transaction requests, please provide ${needed}.`); }
      const verification = verifySession(session, email, last4, this.executor.lookupForVerification(email));
      if (verification.result !== "verified") return this.result(state, verification.session, "I couldn’t verify those details. Please check them and try again.");
      Object.assign(session, verification.session);
      if (!isRefundRequest(message) && !isFrozenCardRequest(message)) return this.result(state, session, "Thanks, your details are verified. How can I help?");
    }
    const customer = session.customerId ? this.store.findCustomerById(session.customerId) : undefined;
    if (customer?.status === "frozen" && isFrozenCardRequest(message)) { const ticket = this.executor.escalate(session.customerId, "frozen: customer asks about frozen card"); return this.result(state, session, `Your card is frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`); }
    if (!isRefundRequest(message)) return this.result(state, session, "I can help with a refund, a card concern, or getting a specialist involved. What do you need?");
    if (!transactionId) return this.result(state, session, "Please share the transaction ID so I can look into the refund.");
    if (amount === undefined) return this.result(state, session, "What refund amount are you requesting?");
    const view = this.executor.getOwnedTransaction(session, transactionId);
    if (!view.found) return this.result(state, session, "I can’t find that transaction for this account.");
    const transaction = this.store.findTransaction(transactionId)!;
    const requiredEscalation = mandatoryEscalation(message, { amount, ageDays: ageInWholeDays(transaction.date, this.executor.now()), pendingUrgent: transaction.status === "pending" && isImmediateCancellation(message) });
    if (requiredEscalation) { const ticket = this.executor.escalate(session.customerId, `${requiredEscalation}: refund request for ${transactionId}`); const explanation = requiredEscalation === "over_cap" ? "Refunds above $75 need a specialist." : requiredEscalation === "age" ? "Transactions 30 days old or older need a specialist." : "This request needs a specialist."; return this.result(state, session, `${explanation} I’ve sent it to the team (ticket ${ticket.ticket_id}).`); }
    const decision = refundEligibility({ session, transaction, amount, now: this.executor.now(), suspectedFraud: fraud.suspected });
    if (!decision.eligible) { const messages: Record<string, string> = { pending: "That transaction is still pending, so it can’t be refunded until it settles.", already_refunded: "That transaction has already been refunded.", exceeds_transaction: "The refund amount can’t be more than the original transaction.", invalid_amount: "Please request an amount greater than $0.", not_owner: "I can’t find that transaction for this account.", not_found: "I can’t find that transaction for this account.", unverified: "Please verify your account details first.", over_cap: "Refunds above $75 need a specialist.", too_old: "This transaction needs specialist review.", suspected_fraud: "I’ll send this to a specialist for investigation." }; return this.result(state, session, messages[decision.reason] ?? "I can’t complete that refund request."); }
    const refund = this.executor.executeRefund(session, transactionId, amount, fraud.suspected); return this.result(state, session, refund.ok ? `Your $${amount.toFixed(2)} refund has been issued (reference ${refund.refund_id}).` : "I couldn’t issue that refund. A specialist can help.");
  }
  private recordResponse(state: AgentStateValue): Partial<AgentStateValue> { return { messages: [...state.messages, { role: "assistant", content: state.response }] }; }
  private result(state: AgentStateValue, session: SupportSession, response: string): Partial<AgentStateValue> { return { messages: state.messages, response, session: structuredClone(session), traces: this.executor.traces }; }
}
