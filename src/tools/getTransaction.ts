import type { MockStore } from "../data/mockStore.js";
import type { TransactionView } from "../domain/transaction.js";

export type GetTransactionResult = { found: true; transaction: TransactionView } | { found: false; reason: "not_found_or_not_owned" };
/** Never reveals a transaction unless the supplied customer ID owns it. */
export function getTransaction(store: MockStore, customerId: string, txnId: string): GetTransactionResult {
  const transaction = store.findTransaction(txnId);
  if (!transaction || transaction.customerId !== customerId) return { found: false, reason: "not_found_or_not_owned" };
  return { found: true, transaction: { amount: transaction.amount, date: transaction.date, merchant: transaction.merchant, status: transaction.status } };
}
