import type { CustomerRecord } from "../domain/customer.js";
import type { TransactionRecord } from "../domain/transaction.js";

export const seedCustomers: CustomerRecord[] = [
  { id: "cus_alice", name: "Alice Rivera", email: "alice@example.com", cardLast4: "4242", status: "active" },
  { id: "cus_bob", name: "Bob Chen", email: "bob@example.com", cardLast4: "1111", status: "active" },
  { id: "cus_frozen", name: "Farah Khan", email: "farah@example.com", cardLast4: "9876", status: "frozen" },
];

export const seedTransactions: TransactionRecord[] = [
  { id: "txn_recent_40", customerId: "cus_alice", amount: 40, date: "2026-10-05", merchant: "Metro Market", status: "settled", refunded: false },
  { id: "txn_exact_75", customerId: "cus_alice", amount: 100, date: "2026-10-06", merchant: "City Books", status: "settled", refunded: false },
  { id: "txn_over_cap", customerId: "cus_alice", amount: 120, date: "2026-10-06", merchant: "Travel Hub", status: "settled", refunded: false },
  { id: "txn_exact_30", customerId: "cus_alice", amount: 35, date: "2026-09-12", merchant: "Old Store", status: "settled", refunded: false },
  { id: "txn_pending", customerId: "cus_alice", amount: 22, date: "2026-10-11", merchant: "Coffee Corner", status: "pending", refunded: false },
  { id: "txn_duplicate", customerId: "cus_bob", amount: 20, date: "2026-10-05", merchant: "Music Stream", status: "refunded", refunded: true },
  { id: "txn_bob", customerId: "cus_bob", amount: 60, date: "2026-10-07", merchant: "Sport Shop", status: "settled", refunded: false },
];
