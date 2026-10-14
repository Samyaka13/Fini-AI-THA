import type { MockStore } from "../data/mockStore.js";
import type { SupportSession } from "../domain/session.js";
import { refundEligibility } from "../policy/refundPolicy.js";
import { escalateToHuman } from "./escalateToHuman.js";
import { getCustomer } from "./getCustomer.js";
import { getTransaction } from "./getTransaction.js";
import { issueRefund, type IssueRefundResult } from "./issueRefund.js";

export type ToolName = "get_customer" | "get_transaction" | "issue_refund" | "escalate_to_human";
export interface ToolTrace { tool: ToolName; args: Record<string, unknown>; result: Record<string, unknown>; }

/** Security boundary. Only these methods are available to the graph/tool caller. */
export class SafeToolExecutor {
  readonly traces: ToolTrace[] = [];
  constructor(readonly store: MockStore, readonly now: () => Date) {}
  lookupForVerification(email: string) {
    const result = getCustomer(this.store, email);
    // The trusted result is returned to verification code, but trace consumers
    // (including an LLM/transcript) learn only whether a record matched.
    this.traces.push({ tool: "get_customer", args: { email: "[redacted]" }, result: { found: result.found } });
    return result;
  }
  getOwnedTransaction(session: SupportSession, txnId: string) {
    if (!session.verified || !session.customerId) return this.record("get_transaction", { customer_id: "[withheld]", txn_id: txnId }, { found: false, reason: "unverified" });
    return this.record("get_transaction", { customer_id: session.customerId, txn_id: txnId }, getTransaction(this.store, session.customerId, txnId));
  }
  getVerifiedCardStatus(session: SupportSession): { found: true; status: "active" | "frozen" } | { found: false; reason: string } {
    if (!session.verified || !session.customerId) return this.record("get_customer", { customer_id: "[withheld]" }, { found: false, reason: "unverified" });
    const customer = this.store.findCustomerById(session.customerId);
    if (!customer || (customer.status !== "active" && customer.status !== "frozen")) return this.record("get_customer", { customer_id: "[verified-session]" }, { found: false, reason: "status_unavailable" });
    return this.record("get_customer", { customer_id: "[verified-session]" }, { found: true, status: customer.status });
  }
  executeRefund(session: SupportSession, txnId: string, amount: number, suspectedFraud: boolean): IssueRefundResult {
    const decision = refundEligibility({ session, transaction: this.store.findTransaction(txnId), amount, now: this.now(), suspectedFraud });
    if (!decision.eligible) return this.record("issue_refund", { txn_id: txnId, amount }, { ok: false, reason: `policy_${decision.reason}` });
    return this.record("issue_refund", { txn_id: txnId, amount }, issueRefund(this.store, txnId, amount));
  }
  recordRefundValidationFailure(txnId: string | null, amount: number | null, reason: string): { ok: false; reason: string } {
    return this.record("issue_refund", { txn_id: txnId ?? "[missing]", amount: amount ?? "[missing]" }, { ok: false, reason });
  }
  recordValidationFailure(tool: ToolName, args: Record<string, unknown>, reason: string): { ok: false; reason: string } {
    return this.record(tool, args, { ok: false, reason });
  }
  escalate(customerId: string | null, summary: string) { return this.record("escalate_to_human", { customer_id: customerId, summary }, escalateToHuman(this.store, customerId, summary, this.now())); }
  private record<T extends object>(tool: ToolName, args: Record<string, unknown>, result: T): T {
    this.traces.push({ tool, args, result: result as Record<string, unknown> });
    return result;
  }
}
