import { describe, expect, it } from "vitest";
import { MockStore } from "../../src/data/mockStore.js";
import { newSession } from "../../src/domain/session.js";
import { verifySession } from "../../src/policy/verification.js";

describe("session verification", () => {
  it("requires both trusted details and only marks the session", () => {
    const store = new MockStore(); const session = newSession(); const customer = store.findCustomerByEmail("alice@example.com");
    expect(verifySession(session, "alice@example.com", null, customer)).toBe("missing_details");
    expect(session.verified).toBe(false);
    expect(verifySession(session, "alice@example.com", "9999", customer)).toBe("failed");
    expect(session.verified).toBe(false);
    expect(verifySession(session, "alice@example.com", "4242", customer)).toBe("verified");
    expect(session).toMatchObject({ verified: true, customerId: "cus_alice" });
    expect(customer?.cardLast4).toBe("4242");
  });
});
