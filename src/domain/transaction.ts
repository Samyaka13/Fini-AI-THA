export type TransactionStatus = "settled" | "pending" | "refunded";

export interface TransactionRecord {
  id: string;
  customerId: string;
  amount: number;
  date: string;
  merchant: string;
  status: TransactionStatus;
  refunded: boolean;
}

export interface TransactionView {
  amount: number;
  date: string;
  merchant: string;
  status: TransactionStatus;
  /** Present only when an authoritative refund record exists. */
  refund: { id: string; amount: number } | null;
}
