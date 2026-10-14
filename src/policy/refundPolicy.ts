import type { SupportSession } from "../domain/session.js";
import type { TransactionRecord } from "../domain/transaction.js";
import { ageInWholeDays } from "../utils/dates.js";

export type RefundDecision =
  | { eligible: true }
  | { eligible: false; reason: "unverified" | "not_found" | "not_owner" | "pending" | "not_settled" | "already_refunded" | "over_cap" | "original_amount_over_cap" | "too_old" | "invalid_amount" | "invalid_transaction_date" | "exceeds_transaction" | "partial_not_allowed" | "suspected_fraud" };

export function refundEligibility(input: { session: SupportSession; transaction?: TransactionRecord; amount: number; now: Date; suspectedFraud: boolean }): RefundDecision {
  const { session, transaction, amount, now, suspectedFraud } = input;
  if (!session.verified || !session.customerId) return { eligible: false, reason: "unverified" };
  if (!transaction) return { eligible: false, reason: "not_found" };
  if (transaction.customerId !== session.customerId) return { eligible: false, reason: "not_owner" };
  if (suspectedFraud) return { eligible: false, reason: "suspected_fraud" };
  if (transaction.refunded || transaction.status === "refunded") return { eligible: false, reason: "already_refunded" };
  if (transaction.status === "pending") return { eligible: false, reason: "pending" };
  if (transaction.status !== "settled") return { eligible: false, reason: "not_settled" };
  const age = ageInWholeDays(transaction.date, now);
  if (age === null) return { eligible: false, reason: "invalid_transaction_date" };
  if (age >= 30) return { eligible: false, reason: "too_old" };
  if (!Number.isFinite(transaction.amount) || transaction.amount <= 0) return { eligible: false, reason: "invalid_amount" };
  if (transaction.amount > 75) return { eligible: false, reason: "original_amount_over_cap" };
  if (!Number.isFinite(amount) || amount <= 0) return { eligible: false, reason: "invalid_amount" };
  if (amount > transaction.amount) return { eligible: false, reason: "exceeds_transaction" };
  if (amount !== transaction.amount) return { eligible: false, reason: "partial_not_allowed" };
  return { eligible: true };
}
