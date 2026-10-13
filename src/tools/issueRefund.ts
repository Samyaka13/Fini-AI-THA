import type { MockStore } from "../data/mockStore.js";

export type IssueRefundResult = { ok: true; refund_id: string } | { ok: false; reason: string };
/** Low-level mock API; policy checks belong to executeRefund before this function is reachable. */
export function issueRefund(store: MockStore, txnId: string, amount: number): IssueRefundResult {
  const transaction = store.findTransaction(txnId);
  if (!transaction) return { ok: false, reason: "transaction_not_found" };
  if (transaction.refunded || transaction.status === "refunded") return { ok: false, reason: "already_refunded" };
  if (transaction.status !== "settled") return { ok: false, reason: "transaction_not_settled" };
  if (!Number.isFinite(amount) || amount <= 0 || amount > 75 || amount > transaction.amount) return { ok: false, reason: "invalid_amount" };
  return { ok: true, refund_id: store.recordRefund(transaction, amount).id };
}
