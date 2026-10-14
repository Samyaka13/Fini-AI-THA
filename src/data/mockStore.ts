import type { CustomerRecord } from "../domain/customer.js";
import type { RefundRecord, SupportTicket } from "../domain/ticket.js";
import type { TransactionRecord } from "../domain/transaction.js";
import { createId } from "../utils/ids.js";
import { seedCustomers, seedTransactions } from "./seed.js";

export class MockStore {
  readonly customers: CustomerRecord[];
  readonly transactions: TransactionRecord[];
  readonly refunds: RefundRecord[] = [];
  readonly tickets: SupportTicket[] = [];

  constructor(customers = seedCustomers, transactions = seedTransactions) {
    this.customers = structuredClone(customers);
    this.transactions = structuredClone(transactions);
  }
  findCustomerByEmail(email: string) { return this.customers.find((c) => c.email.toLowerCase() === email.toLowerCase()); }
  findCustomerById(id: string) { return this.customers.find((c) => c.id === id); }
  findTransaction(id: string) { return this.transactions.find((t) => t.id === id); }
  findRefundByTransaction(transactionId: string) { return this.refunds.find((refund) => refund.transactionId === transactionId); }
  recordRefund(transaction: TransactionRecord, amount: number): RefundRecord {
    const refund = { id: createId("rfd"), transactionId: transaction.id, amount };
    transaction.refunded = true; transaction.status = "refunded"; this.refunds.push(refund); return refund;
  }
  createTicket(customerId: string | null, summary: string, now: Date): SupportTicket {
    const ticket = { id: createId("tkt"), customerId, summary, createdAt: now.toISOString() };
    this.tickets.push(ticket); return ticket;
  }
}
