import { END, START, StateGraph } from "@langchain/langgraph";
import { MockStore } from "../data/mockStore.js";
import { newSession, type SupportSession } from "../domain/session.js";
import type { TransactionView } from "../domain/transaction.js";
import { mandatoryEscalation } from "../policy/escalationPolicy.js";
import { assessFraud } from "../policy/fraudPolicy.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { verifySession } from "../policy/verification.js";
import { SafeToolExecutor, type ToolName, type ToolTrace } from "../tools/registry.js";
import { getCustomerSchema, getTransactionSchema, issueRefundSchema } from "../tools/schemas.js";
import { FIXED_NOW, ageInWholeDays } from "../utils/dates.js";
import { deterministicIntent, extractEmail, extractFraudAmount, extractLast4, extractRefundAmount, extractTransactionId, isAccountClosure, isCardStatusInquiry, isFrozenCardRequest, isHumanEscalationRequest, isImmediateCancellation, isLegalAction, isRefundCancellation, isRefundRequest, isTransactionInquiry, type SupportIntent } from "./routing.js";
import { OpenRouterClient, parseToolArguments, sanitizeForLlm, type LlmClient, type LlmMessage, type LlmToolCall, type StructuredInterpretation } from "./openRouter.js";
import { AgentState, type AgentStateValue } from "./state.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_TOOL_ITERATIONS = 4;
const allowedTools = new Set<ToolName>(["get_customer", "get_transaction", "issue_refund", "escalate_to_human"]);
export interface TurnResult { response: string; session: SupportSession; traces: ToolTrace[]; llmToolCalls: string[]; llmError: string | null; messages: LlmMessage[]; }
export interface AgentOptions { store?: MockStore; now?: () => Date; llm?: LlmClient | null; }

export class PaylaneAgent {
  readonly store: MockStore; readonly executor: SafeToolExecutor; readonly graph; readonly systemPrompt = SYSTEM_PROMPT;
  private readonly llm: LlmClient | null; private session = newSession(); private messages: LlmMessage[] = [];
  constructor(options: AgentOptions = {}) {
    this.store = options.store ?? new MockStore(); this.executor = new SafeToolExecutor(this.store, options.now ?? (() => FIXED_NOW));
    this.llm = options.llm === undefined ? OpenRouterClient.fromEnvironment() : options.llm;
    this.graph = new StateGraph(AgentState)
      .addNode("tool_cycle", (state) => this.runCycle(state))
      .addNode("record_response", (state) => this.recordResponse(state))
      .addEdge(START, "tool_cycle").addEdge("tool_cycle", "record_response").addEdge("record_response", END).compile();
  }
  async respond(input: string): Promise<TurnResult> {
    const start = this.executor.traces.length;
    const state = await this.graph.invoke({ messages: [...this.messages, { role: "user", content: sanitizeForLlm(input) }], response: "", session: this.session, traces: [], llmToolCalls: [], llmError: null, currentInput: input, traceStart: start });
    this.messages = state.messages; this.session = structuredClone(state.session);
    this.logGraphState("=== FINAL GRAPH STATE ===", state);
    return { response: state.response, session: structuredClone(state.session), traces: state.traces, llmToolCalls: state.llmToolCalls.map((call) => call.function.name), llmError: state.llmError, messages: structuredClone(state.messages) };
  }

  private async runCycle(state: AgentStateValue): Promise<Partial<AgentStateValue>> {
    this.logGraphState("=== TOOL_CYCLE: INPUT STATE ===", state);
    const interpretation = await this.getStructuredInterpretation(state.session, state.currentInput);
    const intent = this.resolveIntent(state.currentInput, interpretation);
    const prepared = this.updatePendingRefund(state.session, state.currentInput, intent, interpretation);
    // Read-only transaction/status questions are deterministic. This prevents an
    // LLM from inventing transaction or refund status and does not start a refund.
    if (["fraud_report", "human_escalation", "account_closure", "legal_action", "card_status", "frozen_card_help", "transaction_lookup", "refund_status"].includes(intent)) return this.fallback({ ...state, session: prepared }, null, intent);
    if (!this.llm) return this.fallback({ ...state, session: prepared }, null, intent);
    let messages = [...state.messages]; let session = prepared; const calls: LlmToolCall[] = []; const traceStart = state.traceStart;
    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const completion = await this.llm.complete(messages); calls.push(...completion.toolCalls);
        messages = [...messages, { role: "assistant", content: completion.content, ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls } : {}) }];
        if (!completion.toolCalls.length) {
          if (session.pendingRefund) return this.fallback({ ...state, messages: messages.slice(0, -1), session, llmToolCalls: calls }, null, intent);
          const response = this.safeFinalResponse(completion.content, session, this.executor.traces.slice(traceStart), state.currentInput, traceStart);
          return { messages, response, session, traces: this.executor.traces.slice(traceStart), llmToolCalls: calls, llmError: null };
        }
        // Calls are deliberately dispatched in order. A later call can only see
        // trusted state established by an earlier call in this same completion.
        const results: Array<{ call: LlmToolCall; result: Record<string, unknown>; session: SupportSession }> = [];
        for (const call of completion.toolCalls) {
          const result = this.dispatchTool(call, session, state.currentInput);
          session = result.session;
          results.push(result);
        }
        messages = [...messages, ...results.map(({ call, result }) => ({ role: "tool" as const, tool_call_id: call.id, content: JSON.stringify(result) }))];
      }
      return this.fallback({ ...state, messages, session, llmToolCalls: calls }, "The support assistant reached a safe processing limit.", intent);

    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "LLM unavailable";
    
      console.error("[OpenRouter] Request failed:", errorMessage);
    
      const turnTraces = this.executor.traces.slice(traceStart);
    
      // Never tell the user to retry if an action already succeeded.
      const successfulRefund = turnTraces.find(
        (trace) =>
          trace.tool === "issue_refund" && trace.result.ok === true
      );
    
      const successfulEscalation = turnTraces.find(
        (trace) =>
          trace.tool === "escalate_to_human" &&
          typeof trace.result.ticket_id === "string"
      );
    
      const response = successfulRefund
        ? `Your refund was issued successfully${
            typeof successfulRefund.result.refund_id === "string"
              ? ` (reference ${successfulRefund.result.refund_id})`
              : ""
          }.`
        : successfulEscalation
          ? `I've sent this to a support specialist (ticket ${successfulEscalation.result.ticket_id}).`
          : "Our AI service is not responding right now. Please try again in a little while.";
    
      return {
        // Discard incomplete LLM/tool-call messages from this failed cycle.
        messages: state.messages,
        response,
        session,
        traces: turnTraces,
        llmToolCalls: calls,
        llmError: errorMessage,
      };
    }
    
  }

  private dispatchTool(call: LlmToolCall, currentSession: SupportSession, raw: string): { call: LlmToolCall; result: Record<string, unknown>; session: SupportSession } {
    const session = structuredClone(currentSession); const args = parseToolArguments(call); const pending = session.pendingRefund;
    if (!allowedTools.has(call.function.name as ToolName) || !args) return { call, session, result: { ok: false, error: "invalid_tool_request" } };
    const email = extractEmail(raw); const last4 = extractLast4(raw); const fraud = assessFraud(raw, extractFraudAmount(raw));
    if (call.function.name === "get_customer") {
      if (session.verified) {
        const switchedIdentity = (email && email.toLowerCase() !== (session.suppliedEmail ?? "").toLowerCase()) || (last4 && last4 !== session.suppliedCardLast4);
        return { call, session, result: switchedIdentity ? { ok: false, error: "identity_change_requires_new_session" } : { ok: true, verification: "already_verified" } };
      }
      if (!email || !last4 || !getCustomerSchema.safeParse({ email }).success) return { call, session, result: { ok: false, verification: "missing_details" } };
      const verification = verifySession(session, email, last4, this.executor.lookupForVerification(email));
      return { call, session: verification.session, result: { ok: verification.result === "verified", verification: verification.result } };
    }
    if (call.function.name === "get_transaction") {
      const requestedTxnId = pending?.transactionId ?? extractTransactionId(raw);
      const valid = getTransactionSchema.safeParse({ customer_id: session.customerId ?? "", txn_id: args.txn_id }).success;
      this.logToolDecision("get_transaction", { verified: session.verified, hasPendingRefund: Boolean(pending), hasRequestedTransaction: Boolean(requestedTxnId), argumentsValid: valid });
      const safeArgs = { txn_id: typeof args.txn_id === "string" ? args.txn_id : "[missing]" };
      if (!requestedTxnId) return { call, session, result: this.executor.recordValidationFailure("get_transaction", safeArgs, "missing_transaction_id") };
      if (!valid || args.txn_id !== requestedTxnId) return { call, session, result: this.executor.recordValidationFailure("get_transaction", safeArgs, "invalid_transaction_request") };
      if (pending?.transactionId === requestedTxnId) {
        const lookup = this.ensurePendingTransaction(session);
        return { call, session: lookup.session, result: lookup.alreadyLoaded ? { ok: true, transaction_status: "already_loaded" } : lookup.found ? { ok: true, transaction: lookup.transaction } : { ok: false, error: lookup.reason } };
      }
      const found = this.executor.getOwnedTransaction(session, requestedTxnId);
      return { call, session, result: "transaction" in found ? { ok: true, transaction: found.transaction } : { ok: false, error: found.reason } };
    }
    if (call.function.name === "issue_refund") {
      if (!pending?.transactionId || pending.requestedAmount === null || !issueRefundSchema.safeParse(args).success || args.txn_id !== pending.transactionId || args.amount !== pending.requestedAmount) {
        const result = this.executor.recordRefundValidationFailure(pending?.transactionId ?? null, pending?.requestedAmount ?? null, "refund_arguments_must_match_pending_request");
        return { call, session, result };
      }
      const result = this.executor.executeRefund(session, pending.transactionId, pending.requestedAmount, fraud.suspected);
      return { call, session: result.ok ? { ...session, pendingRefund: null, loadedTransactionId: null } : session, result };
    }
    if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 500) return { call, session, result: this.executor.recordValidationFailure("escalate_to_human", { summary: "[invalid]" }, "invalid_escalation_request") };
    const summary = args.summary.trim();
    const customerId = session.verified ? session.customerId : (email ? this.store.findCustomerByEmail(email)?.id ?? null : null);
    const ticket = this.executor.escalate(customerId, summary);
    return { call, session: { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "model_requested_handoff" } }, result: { ok: true, ticket_id: ticket.ticket_id } };
  }

  private fallback(state: AgentStateValue, llmError: string | null, routedIntent: SupportIntent = deterministicIntent(state.currentInput)): Partial<AgentStateValue> {
    const raw = state.currentInput; let session = state.session; const email = extractEmail(raw) ?? session.suppliedEmail; const last4 = extractLast4(raw) ?? session.suppliedCardLast4; const fraudAmount = extractFraudAmount(raw); const fraud = assessFraud(raw, fraudAmount);
    const identityChanged = session.verified && ((extractEmail(raw) && extractEmail(raw)!.toLowerCase() !== (session.suppliedEmail ?? "").toLowerCase()) || (extractLast4(raw) && extractLast4(raw) !== session.suppliedCardLast4));
    const escalation = mandatoryEscalation(raw, { fraud: fraud.suspected || routedIntent === "fraud_report", immediateFraud: fraud.immediate, legal: isLegalAction(raw) || routedIntent === "legal_action", closure: isAccountClosure(raw) || routedIntent === "account_closure" });
    if (escalation) { const customerId = session.verified ? session.customerId : (extractEmail(raw) ? this.store.findCustomerByEmail(extractEmail(raw)!)?.id ?? null : null); const ticket = this.executor.escalate(customerId, `${escalation}: customer request`); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastEscalation: { ticketId: ticket.ticket_id, reason: escalation } }, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).${escalation === "fraud_immediate" ? " I’ve marked it for immediate review." : ""}`, llmError); }
    if (isHumanEscalationRequest(raw) || routedIntent === "human_escalation") {
      const customerId = session.verified ? session.customerId : (extractEmail(raw) ? this.store.findCustomerByEmail(extractEmail(raw)!)?.id ?? null : null);
      const ticket = this.executor.escalate(customerId, "customer requested human support");
      return this.finish(state, { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "human_requested" } }, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).`, llmError);
    }
    if (identityChanged) return this.finish(state, session, "This support session is verified for a different account. Please start a new session to change account details.", llmError);
    if (!session.verified) { if (!email || !last4) return this.finish(state, { ...session, suppliedEmail: email, suppliedCardLast4: last4 }, `To help with account or transaction requests, please provide ${!email ? "your account email" : "the last four digits of your card"}.`, llmError); const verification = verifySession(session, email, last4, this.executor.lookupForVerification(email)); session = verification.session; if (verification.result !== "verified") return this.finish(state, session, "I couldn’t verify those details. Please check them and try again.", llmError); }
    const customer = session.customerId ? this.store.findCustomerById(session.customerId) : undefined;
    if (isCardStatusInquiry(raw) || routedIntent === "card_status") return this.handleCardStatusInquiry(state, session, llmError);
    if (customer?.status === "frozen" && (isFrozenCardRequest(raw) || routedIntent === "frozen_card_help")) { const ticket = this.executor.escalate(session.customerId, "frozen-card enquiry"); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastEscalation: { ticketId: ticket.ticket_id, reason: "frozen" } }, `Your card is frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, llmError); }
    const pending = session.pendingRefund;
    if (!pending) {
      if (isTransactionInquiry(raw) || routedIntent === "transaction_lookup" || routedIntent === "refund_status") return this.handleTransactionInquiry(state, session, raw, llmError);
      return this.finish(state, session, "I can help with a refund, a card concern, or getting a specialist involved. What do you need?", llmError);
    }
    if (!pending.transactionId) return this.finish(state, session, "Please share the transaction ID so I can look into the refund.", llmError);
    const lookup = this.ensurePendingTransaction(session); session = lookup.session;
    if (!lookup.found) {
      // Keep the workflow active but discard the failed ID so a correction is
      // treated as a continuation rather than a fresh, re-verified request.
      return this.finish(state, { ...session, pendingRefund: { transactionId: null, requestedAmount: pending.requestedAmount }, loadedTransactionId: null }, "I can’t find that transaction for this account. Please check the transaction ID and send the correct one.", llmError);
    }
    if (pending.requestedAmount === null) return this.finish(state, session, "What refund amount are you requesting?", llmError);
    const transaction = this.store.findTransaction(pending.transactionId)!;
    // The automatic cap applies to the original charge as well as the request;
    // a smaller requested amount cannot turn a $120 transaction into a safe
    // automatic refund.
    const required = mandatoryEscalation(raw, { amount: Math.max(pending.requestedAmount, transaction.amount), ageDays: ageInWholeDays(transaction.date, this.executor.now()) ?? undefined, pendingUrgent: transaction.status === "pending" && isImmediateCancellation(raw), fraud: fraud.suspected, immediateFraud: fraud.immediate });
    const exceedsTransaction = pending.requestedAmount > transaction.amount;
    const partialRequest = pending.requestedAmount < transaction.amount;
    if (required) {
      const amountNote = exceedsTransaction ? " Requested amount exceeds the original transaction amount." : partialRequest ? " Automatic refunds must be for the full original transaction amount." : "";
      const ticket = this.executor.escalate(session.customerId, `${required}: refund request${exceedsTransaction ? "; requested amount exceeds original transaction amount" : partialRequest ? "; partial refunds are not allowed" : ""}`);
      const explanation = required === "over_cap" ? "Transactions above $75 need a specialist." : required === "age" ? "Transactions 30 days old or older need a specialist." : "This request needs a specialist.";
      return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastEscalation: { ticketId: ticket.ticket_id, reason: required } }, `${amountNote}${explanation} I’ve sent it to the team (ticket ${ticket.ticket_id}).`, llmError);
    }
    const decision = refundEligibility({ session, transaction, amount: pending.requestedAmount, now: this.executor.now(), suspectedFraud: fraud.suspected });
    if (!decision.eligible) {
      const existingRefund = this.store.findRefundByTransaction(pending.transactionId);
      const explanation = decision.reason === "pending" ? "That transaction is still pending, so it can’t be refunded until it settles."
        : decision.reason === "already_refunded" ? this.describeRefundStatus(existingRefund?.id ?? null, existingRefund?.amount ?? null)
        : decision.reason === "not_settled" ? "That transaction is not settled, so it can’t be refunded automatically."
        : decision.reason === "exceeds_transaction" ? "The requested refund exceeds the original transaction amount, so I can’t issue it automatically."
        : decision.reason === "partial_not_allowed" ? "Automatic refunds must be for the full original transaction amount. I’ve sent this to a specialist."
        : "I can’t complete that refund request.";
      if (decision.reason === "partial_not_allowed") {
        const ticket = this.executor.escalate(session.customerId, "partial refund request; full refund required");
        return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastEscalation: { ticketId: ticket.ticket_id, reason: "partial_refund" } }, `${explanation} (ticket ${ticket.ticket_id}).`, llmError);
      }
      return this.finish(state, { ...session, pendingRefund: decision.reason === "pending" ? session.pendingRefund : null, loadedTransactionId: decision.reason === "pending" ? session.loadedTransactionId : null }, explanation, llmError);
    }
    const refund = this.executor.executeRefund(session, pending.transactionId, pending.requestedAmount, fraud.suspected); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null }, refund.ok ? `Your $${pending.requestedAmount.toFixed(2)} refund has been issued (reference ${refund.refund_id}).` : "I couldn’t issue that refund. A specialist can help.", llmError);
  }

  private updatePendingRefund(base: SupportSession, raw: string, routedIntent: SupportIntent, interpretation: StructuredInterpretation | null = null): SupportSession {
    if (isRefundCancellation(raw)) return { ...base, pendingRefund: null, loadedTransactionId: null };
    const continuing = base.pendingRefund !== null; const startsOrContinues = routedIntent === "refund_request" || continuing;
    if (!startsOrContinues) return base;
    const transactionId = extractTransactionId(raw) ?? (interpretation?.transactionId && raw.toLowerCase().includes(interpretation.transactionId.toLowerCase()) ? interpretation.transactionId : null); const prior = base.pendingRefund ?? { transactionId: null, requestedAmount: null };
    const amount = extractRefundAmount(raw, { allowBareAmount: Boolean(prior.transactionId && prior.requestedAmount === null) });
    // A model may help with wording such as “please return forty dollars”, but
    // may not resolve competing explicit figures on the customer's behalf.
    const hasConflictingExplicitAmounts = new Set(raw.match(/\$\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s+(?:dollars?|usd)\b/gi) ?? []).size > 1;
    const candidateAmount = amount ?? (!hasConflictingExplicitAmounts && prior.transactionId && prior.requestedAmount === null ? interpretation?.amount : undefined);
    const safeAmount = candidateAmount !== undefined && Number.isFinite(candidateAmount) && candidateAmount > 0 ? candidateAmount : undefined;
    const next = transactionId && transactionId !== prior.transactionId
      ? { ...base, pendingRefund: { transactionId, requestedAmount: safeAmount ?? null }, loadedTransactionId: null }
      : { ...base, pendingRefund: { transactionId: prior.transactionId, requestedAmount: safeAmount ?? prior.requestedAmount } };
    this.logRefundState("pending-refund-updated", next, safeAmount);
    return next;
  }
  private async getStructuredInterpretation(session: SupportSession, raw: string): Promise<StructuredInterpretation | null> {
    if (!this.llm?.interpret || !this.needsStructuredInterpretation(session, raw)) return null;
    try { return await this.llm.interpret(sanitizeForLlm(raw)); } catch { return null; }
  }
  private needsStructuredInterpretation(session: SupportSession, raw: string): boolean {
    // Deterministic extraction wins for explicit values. The model is only asked
    // to interpret an unresolved phrase, never to verify or authorize anything.
    if (deterministicIntent(raw) !== "unknown") return false;
    if (extractEmail(raw) || extractLast4(raw) || extractTransactionId(raw)) return false;
    if (extractRefundAmount(raw, { allowBareAmount: Boolean(session.pendingRefund?.transactionId && session.pendingRefund.requestedAmount === null) }) !== undefined) return false;
    return session.pendingRefund?.requestedAmount === null || !isRefundRequest(raw);
  }
  private resolveIntent(raw: string, interpretation: StructuredInterpretation | null): SupportIntent {
    const deterministic = deterministicIntent(raw);
    return deterministic === "unknown" ? interpretation?.intent ?? "unknown" : deterministic;
  }
  private handleTransactionInquiry(state: AgentStateValue, session: SupportSession, raw: string, llmError: string | null): Partial<AgentStateValue> {
    const txnId = extractTransactionId(raw);
    if (!txnId) return this.finish(state, session, "Please share the transaction ID so I can look it up.", llmError);
    const found = this.executor.getOwnedTransaction(session, txnId);
    if (!("transaction" in found)) return this.finish(state, session, "I can’t find that transaction for this account.", llmError);
    return this.finish(state, session, this.describeTransaction(found.transaction), llmError);
  }
  private handleCardStatusInquiry(state: AgentStateValue, session: SupportSession, llmError: string | null): Partial<AgentStateValue> {
    const status = this.executor.getVerifiedCardStatus(session);
    if (!status.found) {
      if (session.lastEscalation) return this.finish(state, session, `I can’t currently confirm your card status. Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
      const ticket = this.executor.escalate(session.customerId, "card-status unavailable");
      return this.finish(state, { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "card_status_unavailable" } }, `I can’t currently confirm your card status, so I’ve sent it to a specialist (ticket ${ticket.ticket_id}).`, llmError);
    }
    if (status.status === "active") {
      const followUp = session.lastEscalation ? ` Your earlier support case (${session.lastEscalation.ticketId}) remains with the specialist.` : "";
      return this.finish(state, session, `The account record currently shows your card as active.${followUp}`, llmError);
    }
    if (session.lastEscalation) return this.finish(state, session, `The account record shows your card as frozen. I can’t access the reason. Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
    const ticket = this.executor.escalate(session.customerId, "frozen-card status enquiry");
    return this.finish(state, { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "frozen" } }, `The account record shows your card as frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, llmError);
  }
  private describeTransaction(transaction: TransactionView): string {
    const details = `The transaction was ${transaction.status} for $${transaction.amount.toFixed(2)} at ${transaction.merchant} on ${transaction.date}.`;
    return transaction.refund ? `${details} A refund of $${transaction.refund.amount.toFixed(2)} was issued (reference ${transaction.refund.id}).` : `${details} No refund has been issued.`;
  }
  private describeRefundStatus(refundId: string | null, amount: number | null): string {
    return refundId && amount !== null
      ? `That transaction has already been refunded for $${amount.toFixed(2)} (reference ${refundId}).`
      : "That transaction has already been refunded.";
  }
  private ensurePendingTransaction(session: SupportSession): { session: SupportSession; found: boolean; alreadyLoaded: boolean; transaction?: unknown; reason?: string } {
    const txnId = session.pendingRefund?.transactionId;
    if (!txnId) return { session, found: false, alreadyLoaded: false, reason: "missing_transaction" };
    if (session.loadedTransactionId === txnId) return { session, found: true, alreadyLoaded: true };
    const found = this.executor.getOwnedTransaction(session, txnId);
    if (!("transaction" in found)) return { session, found: false, alreadyLoaded: false, reason: found.reason };
    return { session: { ...session, loadedTransactionId: txnId }, found: true, alreadyLoaded: false, transaction: found.transaction };
  }
  private logRefundState(stage: string, session: SupportSession, parsedAmount: number | undefined): void {
    if (process.env.PAYLANE_DEBUG !== "true") return;
    console.debug("[refund-state]", { stage, transactionSelected: Boolean(session.pendingRefund?.transactionId), amountProvided: session.pendingRefund?.requestedAmount !== null, parsedAmount: parsedAmount ?? null });
  }
  private logToolDecision(tool: ToolName, details: Record<string, boolean>): void {
    if (process.env.PAYLANE_DEBUG === "true") console.debug("[tool-validation]", { tool, ...details });
  }
  private logGraphState(label: string, state: AgentStateValue): void {
    // Keep the labels and workflow visibility of the original diagnostics, while
    // explicitly excluding trusted input and customer verification secrets.
    console.log(label);
    console.dir({
      messages: state.messages,
      response: state.response,
      session: {
        verified: state.session.verified,
        customerId: state.session.customerId ? "[verified-customer]" : null,
        suppliedEmail: state.session.suppliedEmail ? "[redacted]" : null,
        suppliedCardLast4: state.session.suppliedCardLast4 ? "[redacted]" : null,
        pendingRefund: state.session.pendingRefund,
        loadedTransactionId: state.session.loadedTransactionId,
        hasLastEscalation: state.session.lastEscalation !== null,
      },
      traces: state.traces.map((trace) => ({
        ...trace,
        args: {
          ...trace.args,
          ...(trace.args.customer_id ? { customer_id: "[redacted]" } : {}),
          ...(trace.args.email ? { email: "[redacted]" } : {}),
        },
      })),
      llmToolCalls: state.llmToolCalls.map((call) => call.function.name),
      llmError: state.llmError,
      currentInput: "[trusted input omitted]",
    }, { depth: null });
  }
  private safeFinalResponse(content: string | null, session: SupportSession, traces: ToolTrace[], currentInput: string, traceStart: number): string {
    if (!content?.trim()) return this.fallback({ messages: [], response: "", session, traces: [], llmToolCalls: [], llmError: null, currentInput, traceStart }, null).response ?? "I need a little more information to help.";
    const successfulRefund = traces.some((trace) => trace.tool === "issue_refund" && trace.result.ok === true);
    const successfulTicket = traces.some((trace) => trace.tool === "escalate_to_human" && typeof trace.result.ticket_id === "string");
    if (/(refund.*issued|ticket.*created|sent.*specialist)/i.test(content) && !successfulRefund && !successfulTicket) return "I can’t confirm that action yet. Please provide the requested details so I can continue.";
    if (!successfulRefund && !successfulTicket) {
      const latestTransaction = [...traces].reverse().find((trace) => trace.tool === "get_transaction");
      if (latestTransaction && "transaction" in latestTransaction.result) return this.describeTransaction(latestTransaction.result.transaction as TransactionView);
      if (latestTransaction && latestTransaction.result.found === false) return "I can’t find that transaction for this account. Please check the transaction ID and try again.";
    }
    return content;
  }
  private recordResponse(state: AgentStateValue): Partial<AgentStateValue> { const last = state.messages.at(-1); return last?.role === "assistant" && !last.tool_calls && last.content === state.response ? {} : { messages: [...state.messages, { role: "assistant", content: state.response }] }; }
  private finish(state: AgentStateValue, session: SupportSession, response: string, llmError: string | null): Partial<AgentStateValue> { return { messages: state.messages, session, response, traces: this.executor.traces.slice(state.traceStart), llmToolCalls: state.llmToolCalls, llmError }; }
}
