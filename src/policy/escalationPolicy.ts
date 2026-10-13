export type EscalationReason = "over_cap" | "age" | "fraud" | "fraud_immediate" | "frozen" | "legal" | "closure" | "pending_urgent";
export function mandatoryEscalation(message: string, options: { frozen?: boolean; fraud?: boolean; immediateFraud?: boolean; amount?: number; ageDays?: number; pendingUrgent?: boolean }): EscalationReason | null {
  if (options.fraud) return options.immediateFraud ? "fraud_immediate" : "fraud";
  if (options.amount !== undefined && options.amount > 75) return "over_cap";
  if (options.ageDays !== undefined && options.ageDays >= 30) return "age";
  if (options.frozen) return "frozen";
  if (/legal action|lawyer|attorney|sue|lawsuit/i.test(message)) return "legal";
  if (/close (my |the )?account|account closure/i.test(message)) return "closure";
  if (options.pendingUrgent) return "pending_urgent";
  return null;
}
