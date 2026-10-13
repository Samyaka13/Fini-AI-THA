import type { SupportSession } from "../domain/session.js";
import type { TransactionRecord } from "../domain/transaction.js";
import { ageInWholeDays } from "../utils/dates.js";

export type RefundDecision =
  | { eligible: true }
  | { eligible: false; reason: "unverified" | "not_found" | "not_owner" | "pending" | "already_refunded" | "over_cap" | "too_old" | "invalid_amount" | "exceeds_transaction" | "suspected_fraud" };

export function refundEligibility(input: { session: SupportSession; transaction?: TransactionRecord; amount: number; now: Date; suspectedFraud: boolean }): RefundDecision {
  const { session, transaction, amount, now, suspectedFraud } = input;
  if (!session.verified || !session.customerId) return { eligible: false, reason: "unverified" };
  if (!transaction) return { eligible: false, reason: "not_found" };
  if (transaction.customerId !== session.customerId) return { eligible: false, reason: "not_owner" };
  if (suspectedFraud) return { eligible: false, reason: "suspected_fraud" };
  if (transaction.refunded || transaction.status === "refunded") return { eligible: false, reason: "already_refunded" };
  if (transaction.status === "pending") return { eligible: false, reason: "pending" };
  if (ageInWholeDays(transaction.date, now) >= 30) return { eligible: false, reason: "too_old" };
  if (amount <= 0) return { eligible: false, reason: "invalid_amount" };
  if (amount > 75) return { eligible: false, reason: "over_cap" };
  if (amount > transaction.amount) return { eligible: false, reason: "exceeds_transaction" };
  return { eligible: true };
}
