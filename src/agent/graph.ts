import { END, START, StateGraph } from "@langchain/langgraph";
import { MockStore } from "../data/mockStore.js";
import { newSession, type SupportSession } from "../domain/session.js";
import { mandatoryEscalation } from "../policy/escalationPolicy.js";
import { assessFraud } from "../policy/fraudPolicy.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { verifySession } from "../policy/verification.js";
import { FIXED_NOW } from "../utils/dates.js";
import { SafeToolExecutor, type ToolTrace } from "../tools/registry.js";
import { extractAmount, extractEmail, extractLast4, extractTransactionId, isImmediateCancellation, isRefundRequest } from "./routing.js";
import { AgentState, type AgentStateValue } from "./state.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export interface TurnResult { response: string; session: SupportSession; traces: ToolTrace[]; }
export interface AgentOptions { store?: MockStore; now?: () => Date; }

export class PaylaneAgent {
  readonly store: MockStore;
  readonly executor: SafeToolExecutor;
  readonly graph;
  readonly systemPrompt = SYSTEM_PROMPT;
  private session = newSession();
  private messages: string[] = [];

  constructor(options: AgentOptions = {}) {
    this.store = options.store ?? new MockStore();
    this.executor = new SafeToolExecutor(this.store, options.now ?? (() => FIXED_NOW));
    this.graph = new StateGraph(AgentState).addNode("handle", (state) => this.handle(state)).addEdge(START, "handle").addEdge("handle", END).compile();
  }

  async respond(message: string): Promise<TurnResult> {
    const start = this.executor.traces.length;
    const state = await this.graph.invoke({ messages: [...this.messages, message], response: "", session: this.session, traces: [] });
    this.messages = state.messages;
    this.session = state.session;
    return { response: state.response, session: structuredClone(state.session), traces: this.executor.traces.slice(start) };
  }

  private handle(state: AgentStateValue): Partial<AgentStateValue> {
    const message = state.messages.at(-1) ?? "";
    const email = extractEmail(message) ?? state.session.suppliedEmail;
    const last4 = extractLast4(message) ?? state.session.suppliedCardLast4;
    const amount = extractAmount(message);
    const transactionId = extractTransactionId(message);
    const fraud = assessFraud(message, amount);
    const knownCustomer = email ? this.store.findCustomerByEmail(email) : undefined;

    // Escalation is intentionally available before verification; lookup is internal only.
    const escalation = mandatoryEscalation(message, { fraud: fraud.suspected, immediateFraud: fraud.immediate });
    if (escalation && (!isRefundRequest(message) || fraud.suspected || /legal|lawyer|attorney|sue|close.*account/i.test(message))) {
      const ticket = this.executor.escalate(knownCustomer?.id ?? state.session.customerId, `${escalation}: customer request`);
      const urgent = escalation === "fraud_immediate" ? " I’ve marked it for immediate review." : "";
      return this.result(state, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).${urgent}`, email, last4);
    }

    if (!state.session.verified) {
      if (!email || !last4) {
        const needed = !email && !last4 ? "your account email and the last four digits of your card" : !email ? "your account email" : "the last four digits of your card";
        return this.result(state, `To help with account or transaction requests, please provide ${needed}.`, email, last4);
      }
      // get_customer output stays in trusted code; no record details reach the response/state.
      this.executor.lookupForVerification(email);
      const verification = verifySession(state.session, email, last4, knownCustomer);
      if (verification !== "verified") return this.result(state, "I couldn’t verify those details. Please check them and try again.", email, last4);
      if (!isRefundRequest(message) && !/frozen/i.test(message)) return this.result(state, "Thanks, your details are verified. How can I help?", email, last4);
    }

    const customer = state.session.customerId ? this.store.findCustomerById(state.session.customerId) : undefined;
    if (customer?.status === "frozen") {
      if (!state.session.verified) return this.result(state, "Please provide your account email and the last four digits of your card so I can help.", email, last4);
      const ticket = this.executor.escalate(state.session.customerId, "frozen: customer asks about frozen card");
      return this.result(state, `Your card is frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, email, last4);
    }

    if (!isRefundRequest(message)) return this.result(state, "I can help with a refund, a card concern, or getting a specialist involved. What do you need?", email, last4);
    if (!transactionId) return this.result(state, "Please share the transaction ID so I can look into the refund.", email, last4);
    if (amount === undefined) return this.result(state, "What refund amount are you requesting?", email, last4);

    const view = this.executor.getOwnedTransaction(state.session, transactionId);
    if (!view.found) return this.result(state, "I can’t find that transaction for this account.", email, last4);
    const transaction = this.store.findTransaction(transactionId)!;
    const ageDays = Math.floor((this.executor.now().getTime() - new Date(`${transaction.date}T00:00:00.000Z`).getTime()) / 86_400_000);
    const requiredEscalation = mandatoryEscalation(message, { amount, ageDays, pendingUrgent: transaction.status === "pending" && isImmediateCancellation(message) });
    if (requiredEscalation) {
      const ticket = this.executor.escalate(state.session.customerId, `${requiredEscalation}: refund request for ${transactionId}`);
      const explanation = requiredEscalation === "over_cap" ? "Refunds above $75 need a specialist." : requiredEscalation === "age" ? "Transactions 30 days old or older need a specialist." : "This request needs a specialist.";
      return this.result(state, `${explanation} I’ve sent it to the team (ticket ${ticket.ticket_id}).`, email, last4);
    }
    const decision = refundEligibility({ session: state.session, transaction, amount, now: this.executor.now(), suspectedFraud: fraud.suspected });
    if (!decision.eligible) {
      const messages: Record<string, string> = { pending: "That transaction is still pending, so it can’t be refunded until it settles.", already_refunded: "That transaction has already been refunded.", exceeds_transaction: "The refund amount can’t be more than the original transaction.", invalid_amount: "Please request an amount greater than $0.", not_owner: "I can’t find that transaction for this account.", not_found: "I can’t find that transaction for this account.", unverified: "Please verify your account details first.", over_cap: "Refunds above $75 need a specialist.", too_old: "This transaction needs specialist review.", suspected_fraud: "I’ll send this to a specialist for investigation." };
      return this.result(state, messages[decision.reason] ?? "I can’t complete that refund request.", email, last4);
    }
    const refund = this.executor.executeRefund(state.session, transactionId, amount, false);
    return this.result(state, refund.ok ? `Your $${amount.toFixed(2)} refund has been issued (reference ${refund.refund_id}).` : "I couldn’t issue that refund. A specialist can help.", email, last4);
  }

  private result(state: AgentStateValue, response: string, email: string | null, last4: string | null): Partial<AgentStateValue> {
    state.session.suppliedEmail = email; state.session.suppliedCardLast4 = last4;
    return { messages: state.messages, response, session: state.session, traces: this.executor.traces };
  }
}
