import { END, START, StateGraph } from "@langchain/langgraph";
import { MockStore } from "../data/mockStore.js";
import { newSession, type PendingCardIntent, type SupportSession } from "../domain/session.js";
import type { TransactionRecord, TransactionView } from "../domain/transaction.js";
import { mandatoryEscalation } from "../policy/escalationPolicy.js";
import { assessFraud } from "../policy/fraudPolicy.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { verifySession } from "../policy/verification.js";
import { SafeToolExecutor, type ToolName, type ToolTrace } from "../tools/registry.js";
import { getCustomerSchema, getTransactionSchema, issueRefundSchema } from "../tools/schemas.js";
import { FIXED_NOW, ageInWholeDays } from "../utils/dates.js";
import { deterministicIntent, extractEmail, extractFraudAmount, extractLast4, extractRefundAmount, extractTransactionId, isAccountClosure, isCapabilityInquiry, isCardStatusInquiry, isFrozenCardRequest, isFullRefundRequest, isHumanEscalationRequest, isImmediateCancellation, isLegalAction, isRefundCancellation, isRefundReferenceInquiry, isRefundRequest, isTransactionInquiry, type SupportIntent } from "./routing.js";
import { OpenRouterClient, parseToolArguments, sanitizeForLlm, structuredInterpretationSchema, type EntityCandidates, type LlmClient, type LlmMessage, type LlmToolCall, type StructuredInterpretation } from "./openRouter.js";
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
    return { response: state.response, session: structuredClone(state.session), traces: state.traces, llmToolCalls: state.llmToolCalls.map((call) => call.function.name), llmError: state.llmError, messages: structuredClone(state.messages) };
  }

  private async runCycle(state: AgentStateValue): Promise<Partial<AgentStateValue>> {
    // The raw current turn is parsed locally first. If that leaves a useful
    // ambiguity, the small structured-extraction request supplies only
    // low-authority candidates; reconciliation still happens locally before
    // session persistence, verification, routing, or tool dispatch.
    const interpretation = await this.getStructuredInterpretation(state.session, state.currentInput);
    const reconciliation = this.reconcileEntityCandidates(state.session, state.currentInput, interpretation);
    if (reconciliation.conflicts.length) {
      return this.finish(state, state.session, `I found conflicting ${reconciliation.conflicts.join(" and ")} details. Please send the correct value again.`, null);
    }
    const verifiedSession = this.updateVerificationState(state.session, reconciliation.entities);
    const detectedIntent = this.resolveIntent(state.currentInput, interpretation);
    let prepared = this.updatePendingRefund(verifiedSession, state.currentInput, detectedIntent, reconciliation.entities);
    prepared = this.updatePendingCardIntent(prepared, detectedIntent);
    const intent = detectedIntent === "unknown" ? prepared.pendingCardIntent ?? "unknown" : detectedIntent;
    // A session is permanently bound to its verified customer. Do not let an
    // otherwise ordinary LLM turn turn an identity correction into a switch.
    if (this.hasIdentityConflict(state.session, state.currentInput)) return this.fallback({ ...state, session: prepared }, null, intent);
    // Mandatory safety paths remain manager/policy owned. Ordinary verified
    // transaction and refund requests continue to the LLM tool-selection loop.
    if (["fraud_report", "human_escalation", "account_closure", "legal_action", "card_status", "frozen_card_help"].includes(intent)) return this.fallback({ ...state, session: prepared }, null, intent);
    // A current pending request referring to the most recently verified
    // transaction, or explicitly asking for its full amount, has enough trusted
    // context for the manager to apply policy directly. It must not depend on
    // an LLM to reconstruct “the above transaction” or authorize a refund.
    if (this.shouldResolvePendingRefund(state.currentInput, prepared)) return this.fallback({ ...state, session: prepared }, null, intent);
    // Do not let the LLM speculate with incomplete refund state. The manager
    // owns the lookup, terminal-state checks, and the focused missing-field
    // question before any refund tool call can be considered.
    if (this.hasIncompletePendingRefund(prepared)) return this.fallback({ ...state, session: prepared }, null, intent);
    if (prepared.lastEscalation && this.isEscalationBypassAttempt(state.currentInput)) {
      return this.finish(state, prepared, `I can’t bypass the refund policy or issue this automatically. Your existing support ticket (${prepared.lastEscalation.ticketId}) remains with the specialist.`, null);
    }
    // Verification gates access to account-specific actions, not ordinary
    // conversation.  Let the model answer a greeting or a general question
    // about Paylane support from sanitized history, while this manager still
    // owns every path that can read or change customer data.
    if (!this.llm || (!prepared.verified && this.requiresVerifiedSession(intent))) {
      return this.fallback({ ...state, session: prepared }, null, intent);
    }
    if (this.isRecentRefundFollowUp(state.currentInput, prepared)) return this.handleRecentRefundFollowUp(state, prepared, null);
    if (this.isRecentTransactionFollowUp(state.currentInput, prepared)) return this.handleRecentTransactionFollowUp(state, prepared, null);
    let messages = [...state.messages]; let session = prepared; const calls: LlmToolCall[] = []; const traceStart = state.traceStart;
    try {
      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
        const completion = await this.llm.complete(messages); calls.push(...completion.toolCalls);
        if (!completion.toolCalls.length) {
          if (session.pendingRefund) return this.fallback({ ...state, messages, session, llmToolCalls: calls }, null, intent);
          if (!completion.content?.trim() || this.isUnusableModelResponse(completion.content, session)) {
            return this.fallback({ ...state, messages, session, llmToolCalls: calls }, null, intent);
          }
          const response = this.safeFinalResponse(completion.content, this.executor.traces.slice(traceStart));
          // Do not retain an empty or rejected model fragment.  It is neither a
          // useful conversation turn nor an answer the application endorsed.
          const completedMessages = completion.content === response
            ? [...messages, { role: "assistant" as const, content: completion.content }]
            : messages;
          return { messages: completedMessages, response, session, traces: this.executor.traces.slice(traceStart), llmToolCalls: calls, llmError: null };
        }
        messages = [...messages, { role: "assistant", content: completion.content, tool_calls: completion.toolCalls }];
        // Calls are deliberately dispatched in order. A later call can only see
        // trusted state established by an earlier call in this same completion.
        const results: Array<{ call: LlmToolCall; result: Record<string, unknown>; session: SupportSession }> = [];
        for (const call of completion.toolCalls) {
          const traceCount = this.executor.traces.length;
          const result = this.dispatchTool(call, session, state.currentInput);
          this.executor.traces.slice(traceCount).forEach((trace) => { trace.origin = "llm"; });
          session = result.session;
          results.push(result);
        }
        messages = [...messages, ...results.map(({ call, result }) => ({ role: "tool" as const, tool_call_id: call.id, content: JSON.stringify(result) }))];
      }
      return this.fallback({ ...state, messages, session, llmToolCalls: calls }, "The support assistant reached a safe processing limit.", intent);

    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "LLM unavailable";
    
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
    const fraud = assessFraud(raw, extractFraudAmount(raw));
    if (call.function.name === "get_customer") {
      if (session.verified) {
        const switchedIdentity = this.hasIdentityConflict(session, raw);
        return { call, session, result: switchedIdentity ? { ok: false, error: "identity_change_requires_new_session" } : { ok: true, verification: "already_verified" } };
      }
      // The model receives redacted history, so it is neither a source of
      // credentials nor an authorization boundary. Verification is performed
      // only by updateVerificationState from the raw customer turn.
      const validArgument = getCustomerSchema.safeParse({ email: args.email }).success && typeof args.email === "string" && !this.isPlaceholder(args.email);
      return { call, session, result: { ok: false, verification: session.suppliedEmail && session.suppliedCardLast4 ? "failed" : "missing_details", ...(validArgument ? {} : { error: "invalid_verification_request" }) } };
    }
    if (call.function.name === "get_transaction") {
      const requestedTxnId = pending?.transactionId ?? extractTransactionId(raw);
      const valid = getTransactionSchema.safeParse({ customer_id: session.customerId ?? "", txn_id: args.txn_id }).success;
      const safeArgs = { txn_id: typeof args.txn_id === "string" ? args.txn_id : "[missing]" };
      if (!requestedTxnId) return { call, session, result: this.executor.recordValidationFailure("get_transaction", safeArgs, "missing_transaction_id") };
      if (!valid || args.txn_id !== requestedTxnId) return { call, session, result: this.executor.recordValidationFailure("get_transaction", safeArgs, "invalid_transaction_request") };
      if (pending?.transactionId === requestedTxnId) {
        const lookup = this.ensurePendingTransaction(session);
        return { call, session: lookup.session, result: lookup.alreadyLoaded ? { ok: true, transaction_status: "already_loaded" } : lookup.found ? { ok: true, transaction: lookup.transaction } : { ok: false, error: lookup.reason } };
      }
      const found = this.executor.getOwnedTransaction(session, requestedTxnId);
      return { call, session: "transaction" in found ? { ...session, lastReferencedTransactionId: requestedTxnId } : session, result: "transaction" in found ? { ok: true, transaction: found.transaction } : { ok: false, error: found.reason } };
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
    // Safety-policy escalation is handled in fallback(). A model cannot create
    // a ticket merely because its own refund tool call was rejected, and a retry
    // cannot duplicate an already-confirmed handoff.
    if (pending) return { call, session, result: this.executor.recordValidationFailure("escalate_to_human", { summary }, "refund_requires_policy_resolution") };
    if (session.lastEscalation) return { call, session, result: this.executor.recordValidationFailure("escalate_to_human", { summary }, "escalation_already_created") };
    const customerId = session.verified ? session.customerId : (session.suppliedEmail ? this.store.findCustomerByEmail(session.suppliedEmail)?.id ?? null : null);
    const ticket = this.executor.escalate(customerId, summary);
    return { call, session: { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "model_requested_handoff" } }, result: { ok: true, ticket_id: ticket.ticket_id } };
  }

  private fallback(state: AgentStateValue, llmError: string | null, routedIntent: SupportIntent = deterministicIntent(state.currentInput)): Partial<AgentStateValue> {
    const raw = state.currentInput; let session = state.session; const fraudAmount = extractFraudAmount(raw); const fraud = assessFraud(raw, fraudAmount);
    const identityChanged = this.hasIdentityConflict(session, raw);
    const escalation = mandatoryEscalation(raw, { fraud: fraud.suspected || routedIntent === "fraud_report", immediateFraud: fraud.immediate, legal: isLegalAction(raw) || routedIntent === "legal_action", closure: isAccountClosure(raw) || routedIntent === "account_closure" });
    if (escalation) {
      if (session.lastEscalation?.reason === escalation) return this.finish(state, session, `Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
      const customerId = session.verified ? session.customerId : (session.suppliedEmail ? this.store.findCustomerByEmail(session.suppliedEmail)?.id ?? null : null); const ticket = this.executor.escalate(customerId, `${escalation}: customer request`); this.markLatestTrace("policy"); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastEscalation: { ticketId: ticket.ticket_id, reason: escalation } }, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).${escalation === "fraud_immediate" ? " I’ve marked it for immediate review." : ""}`, llmError);
    }
    if (isHumanEscalationRequest(raw) || routedIntent === "human_escalation") {
      if (session.lastEscalation?.reason === "human_requested") return this.finish(state, session, `Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
      const customerId = session.verified ? session.customerId : (session.suppliedEmail ? this.store.findCustomerByEmail(session.suppliedEmail)?.id ?? null : null);
      const ticket = this.executor.escalate(customerId, "customer requested human support");
      return this.finish(state, { ...session, lastEscalation: { ticketId: ticket.ticket_id, reason: "human_requested" } }, `I’ve sent this to a support specialist (ticket ${ticket.ticket_id}).`, llmError);
    }
    if (identityChanged) return this.finish(state, session, "This support session is verified for a different account. Please start a new session to change account details.", llmError);
    if (isCapabilityInquiry(raw)) return this.finish(state, session, "I can help with transaction lookups, refund requests and refund references, card-status questions, suspected fraud, and connecting you with a support specialist. Account-specific help requires verification with your account email and card last four digits.", llmError);
    if (!session.verified) {
      if (!session.suppliedEmail || !session.suppliedCardLast4) return this.finish(state, session, `To help with account or transaction requests, please provide ${!session.suppliedEmail ? "your account email" : "the last four digits of your card"}.`, llmError);
      // A matching pair is verified by updateVerificationState exactly when a
      // candidate changes. Repeating this fallback must not generate another
      // lookup or let a model-triggered retry control verification.
      return this.finish(state, session, "I couldn’t verify those details. Please check them and try again.", llmError);
    }
    const customer = session.customerId ? this.store.findCustomerById(session.customerId) : undefined;
    if (isCardStatusInquiry(raw) || routedIntent === "card_status") return this.handleCardStatusInquiry(state, session, llmError);
    if (customer?.status === "frozen" && (isFrozenCardRequest(raw) || routedIntent === "frozen_card_help")) { const ticket = this.executor.escalate(session.customerId, "frozen-card enquiry"); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, pendingCardIntent: null, lastEscalation: { ticketId: ticket.ticket_id, reason: "frozen" } }, `Your card is frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, llmError); }
    if (this.isRecentRefundFollowUp(raw, session)) return this.handleRecentRefundFollowUp(state, session, llmError);
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
    const transaction = this.store.findTransaction(pending.transactionId)!;
    const terminalResponse = this.handleTerminalRefundState(state, session, transaction, llmError);
    if (terminalResponse) return terminalResponse;
    if (pending.requestedAmount === null) return this.finish(state, session, "What refund amount are you requesting?", llmError);
    // The automatic cap applies to the original charge as well as the request;
    // a smaller requested amount cannot turn a $120 transaction into a safe
    // automatic refund.
    const required = mandatoryEscalation(raw, { amount: Math.max(pending.requestedAmount, transaction.amount), ageDays: ageInWholeDays(transaction.date, this.executor.now()) ?? undefined, pendingUrgent: transaction.status === "pending" && isImmediateCancellation(raw), fraud: fraud.suspected, immediateFraud: fraud.immediate });
    const exceedsTransaction = pending.requestedAmount > transaction.amount;
    const partialRequest = pending.requestedAmount < transaction.amount;
    if (required) {
      const amountNote = exceedsTransaction ? "Requested amount exceeds the original transaction amount." : partialRequest ? "Automatic refunds must be for the full original transaction amount." : "";
      const ticket = this.executor.escalate(session.customerId, `${required}: refund request${exceedsTransaction ? "; requested amount exceeds original transaction amount" : partialRequest ? "; partial refunds are not allowed" : ""}`); this.markLatestTrace("policy");
      const explanation = required === "over_cap" ? "Transactions above $75 need a specialist." : required === "age" ? "Transactions 30 days old or older need a specialist." : "This request needs a specialist.";
      return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastReferencedTransactionId: pending.transactionId, lastEscalation: { ticketId: ticket.ticket_id, reason: required } }, [amountNote, explanation, `I’ve sent it to the team (ticket ${ticket.ticket_id}).`].filter(Boolean).join(" "), llmError);
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
        const ticket = this.executor.escalate(session.customerId, "partial refund request; full refund required"); this.markLatestTrace("policy");
        return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null, lastReferencedTransactionId: pending.transactionId, lastEscalation: { ticketId: ticket.ticket_id, reason: "partial_refund" } }, `${explanation} (ticket ${ticket.ticket_id}).`, llmError);
      }
      return this.finish(state, { ...session, pendingRefund: decision.reason === "pending" ? session.pendingRefund : null, loadedTransactionId: decision.reason === "pending" ? session.loadedTransactionId : null }, explanation, llmError);
    }
    const refund = this.executor.executeRefund(session, pending.transactionId, pending.requestedAmount, fraud.suspected); return this.finish(state, { ...session, pendingRefund: null, loadedTransactionId: null }, refund.ok ? `Your $${pending.requestedAmount.toFixed(2)} refund has been issued (reference ${refund.refund_id}).` : "I couldn’t issue that refund. A specialist can help.", llmError);
  }

  private updatePendingRefund(base: SupportSession, raw: string, routedIntent: SupportIntent, entities: EntityCandidates): SupportSession {
    if (isRefundCancellation(raw)) return { ...base, pendingRefund: null, loadedTransactionId: null };
    const continuing = base.pendingRefund !== null; const startsOrContinues = routedIntent === "refund_request" || continuing;
    if (!startsOrContinues) return base;
    const prior = base.pendingRefund ?? { transactionId: null, requestedAmount: null };
    const transactionId = entities.transactionId ?? (this.isRecentTransactionReference(raw) ? base.lastReferencedTransactionId : null);
    const amount = extractRefundAmount(raw, { allowBareAmount: Boolean(prior.transactionId && prior.requestedAmount === null) });
    // A model may help with wording such as “please return forty dollars”, but
    // may not resolve competing explicit figures on the customer's behalf.
    const hasConflictingExplicitAmounts = new Set(raw.match(/\$\s*\d+(?:\.\d{1,2})?|\b\d+(?:\.\d{1,2})?\s+(?:dollars?|usd)\b/gi) ?? []).size > 1;
    const fullTransactionId = transactionId ?? prior.transactionId;
    const fullAmount = isFullRefundRequest(raw) ? this.getTrustedFullRefundAmount(base, fullTransactionId) : undefined;
    const candidateAmount = amount ?? fullAmount ?? (!hasConflictingExplicitAmounts && prior.transactionId && prior.requestedAmount === null ? entities.refundAmount ?? undefined : undefined);
    const safeAmount = candidateAmount !== undefined && Number.isFinite(candidateAmount) && candidateAmount > 0 ? candidateAmount : undefined;
    const next = transactionId && transactionId !== prior.transactionId
      ? { ...base, pendingRefund: { transactionId, requestedAmount: safeAmount ?? null }, loadedTransactionId: null }
      : { ...base, pendingRefund: { transactionId: prior.transactionId, requestedAmount: safeAmount ?? prior.requestedAmount } };
    return next;
  }
  private isRecentTransactionReference(raw: string): boolean {
    return /\b(?:above|that|this|previous|prior|last)\s+(?:transaction|charge|payment)\b|\b(?:the\s+)?(?:transaction|charge|payment)\s+above\b|\b(?:refund|return)\b[^.!?]{0,32}\b(?:this|that|it|above)\b/i.test(raw);
  }
  private getTrustedFullRefundAmount(session: SupportSession, transactionId: string | null): number | undefined {
    if (!session.verified || !session.customerId || !transactionId) return undefined;
    const transaction = this.store.findTransaction(transactionId);
    return transaction?.customerId === session.customerId ? transaction.amount : undefined;
  }
  private shouldResolvePendingRefund(raw: string, session: SupportSession): boolean {
    const pending = session.pendingRefund;
    return Boolean(pending && (isFullRefundRequest(raw) || this.isRecentTransactionReference(raw)));
  }
  private hasIncompletePendingRefund(session: SupportSession): boolean {
    return Boolean(session.pendingRefund && (session.pendingRefund.transactionId === null || session.pendingRefund.requestedAmount === null));
  }
  private requiresVerifiedSession(intent: SupportIntent): boolean {
    return ["refund_request", "transaction_lookup", "refund_status"].includes(intent);
  }
  private isEscalationBypassAttempt(raw: string): boolean {
    return /\b(?:bypass|override|ignore)\s+(?:the\s+)?(?:policy|rule)|\b(?:i(?:'m|\s+am)\s+(?:the\s+)?developer|developer\s+testing)|\b(?:issue|process)\b[^.!?]{0,48}\b(?:anyway|regardless|won'?t\s+affect)\b/i.test(raw);
  }
  private handleTerminalRefundState(state: AgentStateValue, session: SupportSession, transaction: TransactionRecord, llmError: string | null): Partial<AgentStateValue> | null {
    const pending = session.pendingRefund;
    if (!pending?.transactionId) return null;
    const completed = { ...session, pendingRefund: null, loadedTransactionId: null, lastReferencedTransactionId: pending.transactionId };
    if (transaction.refunded || transaction.status === "refunded") {
      const refund = this.store.findRefundByTransaction(transaction.id);
      return this.finish(state, completed, this.describeRefundStatus(refund?.id ?? null, refund?.amount ?? null), llmError);
    }
    if (transaction.status === "pending") {
      if (isImmediateCancellation(state.currentInput)) {
        if (session.lastEscalation?.reason === "pending_urgent") return this.finish(state, session, `Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
        const ticket = this.executor.escalate(session.customerId, "pending transaction requires immediate cancellation review"); this.markLatestTrace("policy");
        return this.finish(state, { ...completed, lastEscalation: { ticketId: ticket.ticket_id, reason: "pending_urgent" } }, `That transaction is still pending, so it can’t be refunded until it settles. I’ve sent the immediate-cancellation request to a specialist (ticket ${ticket.ticket_id}).`, llmError);
      }
      return this.finish(state, completed, "That transaction is still pending, so it can’t be refunded until it settles.", llmError);
    }
    const ageDays = ageInWholeDays(transaction.date, this.executor.now());
    const reason = transaction.amount > 75 ? "over_cap" : ageDays !== null && ageDays >= 30 ? "age" : null;
    if (!reason) return null;
    if (session.lastEscalation?.reason === reason) return this.finish(state, completed, `Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
    const isPartial = pending.requestedAmount !== null && pending.requestedAmount < transaction.amount;
    const exceedsTransaction = pending.requestedAmount !== null && pending.requestedAmount > transaction.amount;
    const ticket = this.executor.escalate(session.customerId, `${reason}: refund request${exceedsTransaction ? "; requested amount exceeds original transaction amount" : isPartial ? "; partial refunds are not allowed" : ""}`); this.markLatestTrace("policy");
    const amountNote = exceedsTransaction ? "Requested amount exceeds the original transaction amount." : isPartial ? "Automatic refunds must be for the full original transaction amount." : "";
    const explanation = reason === "over_cap" ? "Transactions above $75 need a specialist." : "Transactions 30 days old or older need a specialist.";
    return this.finish(state, { ...completed, lastEscalation: { ticketId: ticket.ticket_id, reason } }, [amountNote, explanation, `I’ve sent it to the team (ticket ${ticket.ticket_id}).`].filter(Boolean).join(" "), llmError);
  }
  private updateVerificationState(base: SupportSession, entities: EntityCandidates): SupportSession {
    // A verified session remains bound to the original customer. The caller
    // handles an explicit identity-change message without replacing credentials.
    if (base.verified) return base;
    const email = entities.email && getCustomerSchema.safeParse({ email: entities.email }).success && !this.isPlaceholder(entities.email)
      ? entities.email.toLowerCase()
      : null;
    const last4 = entities.cardLast4 && /^\d{4}$/.test(entities.cardLast4) && !this.isPlaceholder(entities.cardLast4)
      ? entities.cardLast4
      : null;
    const nextEmail = email ?? base.suppliedEmail;
    const nextLast4 = last4 ?? base.suppliedCardLast4;
    const changed = nextEmail !== base.suppliedEmail || nextLast4 !== base.suppliedCardLast4;
    if (!changed) return base;
    const merged = { ...base, suppliedEmail: nextEmail, suppliedCardLast4: nextLast4 };
    if (!nextEmail || !nextLast4) return merged;
    return verifySession(merged, nextEmail, nextLast4, this.executor.lookupForVerification(nextEmail)).session;
  }
  private reconcileEntityCandidates(session: SupportSession, raw: string, interpretation: StructuredInterpretation | null): { entities: EntityCandidates; conflicts: string[] } {
    const deterministic: EntityCandidates = {
      email: extractEmail(raw),
      cardLast4: extractLast4(raw),
      transactionId: extractTransactionId(raw),
      refundAmount: extractRefundAmount(raw, { allowBareAmount: Boolean(session.pendingRefund?.transactionId && session.pendingRefund.requestedAmount === null) }) ?? null,
    };
    const structured = interpretation?.entities;
    const conflicts: string[] = [];
    const resolve = (name: string, deterministicValue: string | number | null, structuredValue: string | number | null, validStructured: (value: string | number) => boolean): string | number | null => {
      if (deterministicValue !== null && structuredValue !== null && deterministicValue !== structuredValue) {
        conflicts.push(name);
        return null;
      }
      if (deterministicValue !== null) return deterministicValue;
      return structuredValue !== null && validStructured(structuredValue) ? structuredValue : null;
    };
    const email = resolve("email", deterministic.email, structured?.email ?? null, (value) => typeof value === "string" && getCustomerSchema.safeParse({ email: value }).success && this.isCandidateInRaw(raw, value));
    const cardLast4 = resolve("card last four", deterministic.cardLast4, structured?.cardLast4 ?? null, (value) => typeof value === "string" && /^\d{4}$/.test(value) && this.isCardCandidateInRaw(raw, value));
    const transactionId = resolve("transaction", deterministic.transactionId, structured?.transactionId ?? null, (value) => typeof value === "string" && /^txn_[a-z0-9_]+$/i.test(value) && this.isCandidateInRaw(raw, value));
    const refundAmount = resolve("refund amount", deterministic.refundAmount, structured?.refundAmount ?? null, (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && this.isRefundAmountGrounded(raw, session));
    return {
      entities: {
        email: typeof email === "string" ? email : null,
        cardLast4: typeof cardLast4 === "string" ? cardLast4 : null,
        transactionId: typeof transactionId === "string" ? transactionId : null,
        refundAmount: typeof refundAmount === "number" ? refundAmount : null,
      },
      conflicts,
    };
  }
  private isCandidateInRaw(raw: string, value: string): boolean { return raw.toLowerCase().includes(value.toLowerCase()); }
  private isCardCandidateInRaw(raw: string, value: string): boolean {
    const fourDigitValues = raw.match(/\b\d{4}\b/g) ?? [];
    return fourDigitValues.length === 1 && new RegExp(`\\b${value}\\b`).test(raw) && /\b(?:card|last|digit|number|ends?|tail)\b/i.test(raw);
  }
  private isRefundAmountGrounded(raw: string, session: SupportSession): boolean {
    const explicitAmount = /(?:\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:bucks|dollas|dollars?|usd)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b)/i.test(raw);
    return explicitAmount && (/\b(?:refund|return|back)\b/i.test(raw) || Boolean(session.pendingRefund?.transactionId && session.pendingRefund.requestedAmount === null));
  }
  private updatePendingCardIntent(session: SupportSession, intent: SupportIntent): SupportSession {
    if (intent === "card_status" || intent === "frozen_card_help") return { ...session, pendingCardIntent: intent as PendingCardIntent };
    if (intent !== "unknown") return { ...session, pendingCardIntent: null };
    return session;
  }
  private hasIdentityConflict(session: SupportSession, raw: string): boolean {
    if (!session.verified) return false;
    const email = extractEmail(raw);
    const last4 = extractLast4(raw);
    return Boolean(
      (email && !this.isPlaceholder(email) && email.toLowerCase() !== (session.suppliedEmail ?? "").toLowerCase()) ||
      (last4 && !this.isPlaceholder(last4) && last4 !== session.suppliedCardLast4),
    );
  }
  private isPlaceholder(value: string): boolean { return /^\s*\[(?:account-email|card-last-four)\]\s*$/i.test(value); }
  private async getStructuredInterpretation(session: SupportSession, raw: string): Promise<StructuredInterpretation | null> {
    if (!this.llm?.interpret || !this.needsStructuredInterpretation(session, raw)) return null;
    // This request contains the current turn only. Conversation history remains
    // redacted, and the result is treated as an untrusted candidate below.
    try { return structuredInterpretationSchema.safeParse(await this.llm.interpret(raw)).data ?? null; } catch { return null; }
  }
  private needsStructuredInterpretation(session: SupportSession, raw: string): boolean {
    // Deterministic extraction wins for explicit values. Ask the extractor only
    // when a value-shaped phrase remains unresolved, or routing needs language
    // interpretation; it never verifies or authorizes anything.
    const unresolvedEmail = !extractEmail(raw) && /@/.test(raw);
    const unresolvedCard = !extractLast4(raw) && /\b\d{4}\b/.test(raw) && /\b(?:card|last|digits?|numbers?|ends?|tail)\b/i.test(raw);
    if (!session.verified && (unresolvedEmail || unresolvedCard)) return true;
    if (session.verified && (unresolvedEmail || unresolvedCard)) return false;
    if (extractEmail(raw) || extractLast4(raw) || extractTransactionId(raw)) return false;
    if (deterministicIntent(raw) !== "unknown") return false;
    // A general question is best answered directly by the conversational
    // model.  It has no low-authority entity candidates to extract first.
    if (isCapabilityInquiry(raw)) return false;
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
    return this.finish(state, { ...session, lastReferencedTransactionId: txnId }, this.describeTransaction(found.transaction), llmError);
  }
  private isRecentTransactionFollowUp(raw: string, session: SupportSession): boolean {
    return Boolean(
      session.lastReferencedTransactionId &&
      !extractTransactionId(raw) &&
      /\b(?:original\s+)?(?:transaction|charge|payment)\s+amount\b|\boriginal\s+amount\b/i.test(raw),
    );
  }
  private isRecentRefundFollowUp(raw: string, session: SupportSession): boolean {
    return Boolean(session.lastReferencedTransactionId && !extractTransactionId(raw) && isRefundReferenceInquiry(raw));
  }
  private handleRecentRefundFollowUp(state: AgentStateValue, session: SupportSession, llmError: string | null): Partial<AgentStateValue> {
    const txnId = session.lastReferencedTransactionId;
    if (!txnId) return this.finish(state, session, "Please share the transaction ID so I can look it up.", llmError);
    const found = this.executor.getOwnedTransaction(session, txnId);
    if (!("transaction" in found)) return this.finish(state, session, "I can’t find that transaction for this account.", llmError);
    return this.finish(state, session, found.transaction.refund
      ? `The refund reference is ${found.transaction.refund.id} for $${found.transaction.refund.amount.toFixed(2)}.`
      : "No refund has been issued for that transaction.", llmError);
  }
  private handleRecentTransactionFollowUp(state: AgentStateValue, session: SupportSession, llmError: string | null): Partial<AgentStateValue> {
    const txnId = session.lastReferencedTransactionId;
    if (!txnId) return this.finish(state, session, "Please share the transaction ID so I can look it up.", llmError);
    const found = this.executor.getOwnedTransaction(session, txnId);
    if (!("transaction" in found)) return this.finish(state, session, "I can’t find that transaction for this account.", llmError);
    return this.finish(state, session, `The original transaction amount was $${found.transaction.amount.toFixed(2)}.`, llmError);
  }
  private handleCardStatusInquiry(state: AgentStateValue, session: SupportSession, llmError: string | null): Partial<AgentStateValue> {
    const completedSession = { ...session, pendingCardIntent: null };
    const status = this.executor.getVerifiedCardStatus(session);
    if (!status.found) {
      if (session.lastEscalation) return this.finish(state, completedSession, `I can’t currently confirm your card status. Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
      const ticket = this.executor.escalate(session.customerId, "card-status unavailable");
      return this.finish(state, { ...completedSession, lastEscalation: { ticketId: ticket.ticket_id, reason: "card_status_unavailable" } }, `I can’t currently confirm your card status, so I’ve sent it to a specialist (ticket ${ticket.ticket_id}).`, llmError);
    }
    if (status.status === "active") {
      const followUp = session.lastEscalation ? ` Your earlier support case (${session.lastEscalation.ticketId}) remains with the specialist.` : "";
      return this.finish(state, completedSession, `The account record currently shows your card as active.${followUp}`, llmError);
    }
    if (session.lastEscalation) return this.finish(state, completedSession, `The account record shows your card as frozen. I can’t access the reason. Your existing support ticket (${session.lastEscalation.ticketId}) remains with the specialist.`, llmError);
    const ticket = this.executor.escalate(session.customerId, "frozen-card status enquiry");
    return this.finish(state, { ...completedSession, lastEscalation: { ticketId: ticket.ticket_id, reason: "frozen" } }, `The account record shows your card as frozen. I can’t access the reason, so I’ve sent this to a specialist (ticket ${ticket.ticket_id}).`, llmError);
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
    return { session: { ...session, loadedTransactionId: txnId, lastReferencedTransactionId: txnId }, found: true, alreadyLoaded: false, transaction: found.transaction };
  }
  private markLatestTrace(origin: "manager" | "policy"): void {
    const latest = this.executor.traces.at(-1);
    if (latest) latest.origin = origin;
  }
  private safeFinalResponse(content: string, traces: ToolTrace[]): string {
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
  private isUnusableModelResponse(content: string, session: SupportSession): boolean {
    const asksForVerification = /\b(?:provide|share|send|confirm|enter)\b[^.!?]{0,100}\b(?:email|card|last\s*(?:four|4)|digits?)\b/i.test(content);
    // A provider can occasionally return a cut-off request such as “could you
    // please provide”. Returning it is misleading, and it must not become part
    // of the next model-visible history turn.
    const trailingRequest = /\b(?:please\s+)?(?:provide|share|send|confirm|enter)\s*$/i.test(content);
    // Providers can also stop partway through a sentence or Markdown bullet.
    // Treat these fragments like an empty result rather than persisting text
    // such as "- **Support &" as a customer-facing answer.
    const unmatchedBoldMarker = (content.match(/\*\*/g) ?? []).length % 2 !== 0;
    const hangingEnding = /(?:[&/,:;]|\b(?:and|or|with|for|to))\s*$/i.test(content);
    return trailingRequest || unmatchedBoldMarker || hangingEnding || (session.verified && asksForVerification);
  }
  private recordResponse(state: AgentStateValue): Partial<AgentStateValue> { const last = state.messages.at(-1); return last?.role === "assistant" && !last.tool_calls && last.content === state.response ? {} : { messages: [...state.messages, { role: "assistant", content: state.response }] }; }
  private finish(state: AgentStateValue, session: SupportSession, response: string, llmError: string | null): Partial<AgentStateValue> { return { messages: state.messages, session, response, traces: this.executor.traces.slice(state.traceStart), llmToolCalls: state.llmToolCalls, llmError }; }
}
