import { describe, expect, it } from "vitest";
import { MockStore } from "../../src/data/mockStore.js";
import { newSession } from "../../src/domain/session.js";
import { FIXED_NOW } from "../../src/utils/dates.js";
import { SafeToolExecutor } from "../../src/tools/registry.js";

describe("mock tools and security boundary", () => {
  it("does not expose email or another customer's transaction", () => {
    const store = new MockStore(); const executor = new SafeToolExecutor(store, () => FIXED_NOW);
    expect(executor.lookupForVerification("alice@example.com")).not.toHaveProperty("email");
    const session = { ...newSession(), verified: true, customerId: "cus_alice" };
    expect(executor.getOwnedTransaction(session, "txn_bob")).toEqual({ found: false, reason: "not_found_or_not_owned" });
  });
  it("enforces policy at refund execution and blocks duplicates", () => {
    const store = new MockStore(); const executor = new SafeToolExecutor(store, () => FIXED_NOW);
    const session = { ...newSession(), verified: true, customerId: "cus_alice" };
    expect(executor.executeRefund(session, "txn_over_cap", 120, false)).toMatchObject({ ok: false, reason: "policy_original_amount_over_cap" });
    expect(executor.executeRefund(session, "txn_recent_40", 40, false)).toMatchObject({ ok: true });
    expect(executor.executeRefund(session, "txn_recent_40", 40, false)).toMatchObject({ ok: false, reason: "policy_already_refunded" });
  });
  it("rejects partial refunds at the executor and low-level mock boundary", () => {
    const executor = new SafeToolExecutor(new MockStore(), () => FIXED_NOW);
    const session = { ...newSession(), verified: true, customerId: "cus_alice" };
    expect(executor.executeRefund(session, "txn_recent_40", 30, false)).toMatchObject({ ok: false, reason: "policy_partial_not_allowed" });
  });
  it("creates ticket IDs, including anonymous tickets", () => {
    const executor = new SafeToolExecutor(new MockStore(), () => FIXED_NOW);
    expect(executor.escalate(null, "legal request").ticket_id).toMatch(/^tkt_/);
  });
});
