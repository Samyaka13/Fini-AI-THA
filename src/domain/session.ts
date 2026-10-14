export interface PendingRefund {
  transactionId: string | null;
  requestedAmount: number | null;
}
export interface EscalationContext {
  ticketId: string;
  reason: string;
}

/** A card question that arrived before the customer completed verification. */
export type PendingCardIntent = "card_status" | "frozen_card_help";

export interface SupportSession {
  verified: boolean;
  customerId: string | null;
  suppliedEmail: string | null;
  suppliedCardLast4: string | null;
  pendingRefund: PendingRefund | null;
  /** The current pending transaction has already passed the ownership lookup. */
  loadedTransactionId: string | null;
  /** Most recent confirmed handoff in this support session. */
  lastEscalation: EscalationContext | null;
  /** Card-support intent retained only while collecting verification details. */
  pendingCardIntent: PendingCardIntent | null;
}

export const newSession = (): SupportSession => ({
  verified: false,
  customerId: null,
  suppliedEmail: null,
  suppliedCardLast4: null,
  pendingRefund: null,
  loadedTransactionId: null,
  lastEscalation: null,
  pendingCardIntent: null,
});
