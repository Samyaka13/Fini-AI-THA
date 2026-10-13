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
}
