import type { CustomerRecord } from "../domain/customer.js";
import type { TransactionRecord } from "../domain/transaction.js";

export const seedCustomers: CustomerRecord[] = [
  {
    id: "cus_aarav",
    name: "Aarav Sharma",
    email: "aarav@example.com",
    cardLast4: "4242",
    status: "active",
  },
  {
    id: "cus_priya",
    name: "Priya Patel",
    email: "priya@example.com",
    cardLast4: "1111",
    status: "active",
  },
  {
    id: "cus_frozen",
    name: "Farah Khan",
    email: "farah@example.com",
    cardLast4: "9876",
    status: "frozen",
  },
  {
    id: "cus_rohan",
    name: "Rohan Verma",
    email: "rohan@example.com",
    cardLast4: "5678",
    status: "active",
  },
  {
    id: "cus_neha",
    name: "Neha Iyer",
    email: "neha@example.com",
    cardLast4: "2468",
    status: "active",
  },
  {
    id: "cus_arjun",
    name: "Arjun Mehta",
    email: "arjun@example.com",
    cardLast4: "1357",
    status: "active",
  },
  {
    id: "cus_kavya",
    name: "Kavya Rao",
    email: "kavya@example.com",
    cardLast4: "8080",
    status: "active",
  },
  {
    id: "cus_vikram",
    name: "Vikram Singh",
    email: "vikram@example.com",
    cardLast4: "3141",
    status: "active",
  },
  {
    id: "cus_ananya",
    name: "Ananya Das",
    email: "ananya@example.com",
    cardLast4: "6262",
    status: "active",
  },
  {
    id: "cus_ishaan",
    name: "Ishaan Gupta",
    email: "ishaan@example.com",
    cardLast4: "9090",
    status: "active",
  },
];

export const seedTransactions: TransactionRecord[] = [
  // Eligible full refund: settled, under $75, less than 30 days old.
  {
    id: "txn_recent_40",
    customerId: "cus_aarav",
    amount: 40,
    date: "2026-10-05",
    merchant: "Fresh Mart",
    status: "settled",
    refunded: false,
  },

  // Boundary case: exactly $75 is eligible if all other rules pass.
  {
    id: "txn_exact_75",
    customerId: "cus_aarav",
    amount: 75,
    date: "2026-10-06",
    merchant: "City Books",
    status: "settled",
    refunded: false,
  },

  // Above the automatic refund limit: must escalate.
  {
    id: "txn_over_cap",
    customerId: "cus_aarav",
    amount: 120,
    date: "2026-10-06",
    merchant: "Travel Hub",
    status: "settled",
    refunded: false,
  },

  // Exactly 30 calendar days before the fixed test date: must escalate.
  {
    id: "txn_exact_30",
    customerId: "cus_aarav",
    amount: 35,
    date: "2026-09-12",
    merchant: "Old Store",
    status: "settled",
    refunded: false,
  },

  // Older than 30 days: must escalate.
  {
    id: "txn_over_30",
    customerId: "cus_aarav",
    amount: 50,
    date: "2026-09-11",
    merchant: "Classic Clothing",
    status: "settled",
    refunded: false,
  },

  // Pending authorization: not eligible for a refund yet.
  {
    id: "txn_pending",
    customerId: "cus_aarav",
    amount: 22,
    date: "2026-10-11",
    merchant: "Coffee Corner",
    status: "pending",
    refunded: false,
  },

  // Already refunded: must not be refunded again.
  {
    id: "txn_duplicate",
    customerId: "cus_priya",
    amount: 20,
    date: "2026-10-05",
    merchant: "Music Stream",
    status: "refunded",
    refunded: true,
  },

  // Eligible full refund for a second verified customer.
  {
    id: "txn_rohan_60",
    customerId: "cus_rohan",
    amount: 60,
    date: "2026-10-07",
    merchant: "Sport Shop",
    status: "settled",
    refunded: false,
  },

  // Farah has a frozen card. This transaction is otherwise refund-eligible,
  // but a $40 partial refund request must be escalated.
  {
    id: "txn_farah_45",
    customerId: "cus_frozen",
    amount: 45,
    date: "2026-10-08",
    merchant: "Fresh Mart",
    status: "settled",
    refunded: false,
  },

  // A small eligible transaction for clarification and full-refund tests.
  {
    id: "txn_priya_25",
    customerId: "cus_priya",
    amount: 25,
    date: "2026-10-09",
    merchant: "Green Basket",
    status: "settled",
    refunded: false,
  },

  // Fraud escalation: above $500, so immediate human escalation is required.
  {
    id: "txn_fraud_650",
    customerId: "cus_priya",
    amount: 650,
    date: "2026-10-10",
    merchant: "Electronics World",
    status: "settled",
    refunded: false,
  },

  // Fraud report at exactly $500: still escalate because it is suspected fraud.
  {
    id: "txn_fraud_500",
    customerId: "cus_neha",
    amount: 500,
    date: "2026-10-10",
    merchant: "Online Gadgets",
    status: "settled",
    refunded: false,
  },

  // Another eligible amount near the automatic refund cap.
  {
    id: "txn_neha_74",
    customerId: "cus_neha",
    amount: 74,
    date: "2026-10-04",
    merchant: "Home Essentials",
    status: "settled",
    refunded: false,
  },

  // Eligible amount for a separate customer and ownership test.
  {
    id: "txn_arjun_55",
    customerId: "cus_arjun",
    amount: 55,
    date: "2026-10-01",
    merchant: "Metro Store",
    status: "settled",
    refunded: false,
  },

  // Pending transaction on the fixed test date.
  {
    id: "txn_kavya_pending",
    customerId: "cus_kavya",
    amount: 17,
    date: "2026-10-12",
    merchant: "Daily Brew",
    status: "pending",
    refunded: false,
  },

  // Just under 30 calendar days old on the fixed test date.
  {
    id: "txn_vikram_30",
    customerId: "cus_vikram",
    amount: 30,
    date: "2026-09-13",
    merchant: "Book House",
    status: "settled",
    refunded: false,
  },

  // Another exactly-$75 transaction for boundary testing.
  {
    id: "txn_rohan_75",
    customerId: "cus_rohan",
    amount: 75,
    date: "2026-10-11",
    merchant: "Fashion Point",
    status: "settled",
    refunded: false,
  },

  // Older transaction for testing the age-based escalation policy.
  {
    id: "txn_ananya_old",
    customerId: "cus_ananya",
    amount: 49,
    date: "2026-09-04",
    merchant: "Lifestyle Store",
    status: "settled",
    refunded: false,
  },

  // Another eligible transaction that belongs only to Ishaan.
  {
    id: "txn_ishaan_70",
    customerId: "cus_ishaan",
    amount: 70,
    date: "2026-10-08",
    merchant: "Market Square",
    status: "settled",
    refunded: false,
  },

  // A second already-refunded transaction to test repeat-refund prevention.
  {
    id: "txn_rohan_refunded",
    customerId: "cus_rohan",
    amount: 40,
    date: "2026-10-03",
    merchant: "Movie House",
    status: "refunded",
    refunded: true,
  },
];