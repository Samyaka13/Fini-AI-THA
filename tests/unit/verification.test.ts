import { describe, expect, it } from "vitest";
import { MockStore } from "../../src/data/mockStore.js";
import { newSession } from "../../src/domain/session.js";
import { verifySession } from "../../src/policy/verification.js";

describe("session verification", () => {
  it("requires both trusted details and only marks the session", () => {
    const store = new MockStore(); const session = newSession(); const customer = store.findCustomerByEmail("alice@example.com");
    const lookup = customer ? { found: true as const, id: customer.id, name: customer.name, card_last4: customer.cardLast4, status: customer.status, verified: false as const } : { found: false as const, reason: "not_found" as const };
    expect(verifySession(session, "alice@example.com", null, lookup).result).toBe("missing_details");
    expect(session.verified).toBe(false);
    expect(verifySession(session, "alice@example.com", "9999", lookup).result).toBe("failed");
    expect(session.verified).toBe(false);
    const verified = verifySession(session, "alice@example.com", "4242", lookup);
    expect(verified.result).toBe("verified");
    expect(verified.session).toMatchObject({ verified: true, customerId: "cus_alice" });
    expect(session).toMatchObject({ verified: false, customerId: null });
    expect(customer?.cardLast4).toBe("4242");
  });
});
