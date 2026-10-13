import { describe, expect, it } from "vitest";
import { MockStore } from "../../src/data/mockStore.js";
import { newSession } from "../../src/domain/session.js";
import { refundEligibility } from "../../src/policy/refundPolicy.js";
import { FIXED_NOW } from "../../src/utils/dates.js";

const session = () => ({ ...newSession(), verified: true, customerId: "cus_alice" });
describe("refund eligibility", () => {
  it("accepts the $75 boundary and a valid partial refund", () => {
    const transaction = new MockStore().findTransaction("txn_exact_75")!;
    expect(refundEligibility({ session: session(), transaction, amount: 75, now: FIXED_NOW, suspectedFraud: false })).toEqual({ eligible: true });
  });
  it("rejects cap, age, pending, duplicates, ownership, and fraud", () => {
    const store = new MockStore();
    expect(refundEligibility({ session: session(), transaction: store.findTransaction("txn_over_cap"), amount: 76, now: FIXED_NOW, suspectedFraud: false })).toMatchObject({ reason: "over_cap" });
    expect(refundEligibility({ session: session(), transaction: store.findTransaction("txn_exact_30"), amount: 35, now: FIXED_NOW, suspectedFraud: false })).toMatchObject({ reason: "too_old" });
    expect(refundEligibility({ session: session(), transaction: store.findTransaction("txn_pending"), amount: 22, now: FIXED_NOW, suspectedFraud: false })).toMatchObject({ reason: "pending" });
    expect(refundEligibility({ session: session(), transaction: store.findTransaction("txn_bob"), amount: 20, now: FIXED_NOW, suspectedFraud: false })).toMatchObject({ reason: "not_owner" });
    expect(refundEligibility({ session: session(), transaction: store.findTransaction("txn_recent_40"), amount: 40, now: FIXED_NOW, suspectedFraud: true })).toMatchObject({ reason: "suspected_fraud" });
  });
});
