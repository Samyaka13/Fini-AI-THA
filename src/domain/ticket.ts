export interface RefundRecord { id: string; transactionId: string; amount: number; }
export interface SupportTicket {
  id: string;
  customerId: string | null;
  summary: string;
  createdAt: string;
}
