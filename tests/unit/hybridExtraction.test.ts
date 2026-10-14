import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient } from "../../src/agent/openRouter.js";

const alice = "My email is alice@example.com and my card last four digits are 4242.";

describe("hybrid deterministic and structured extraction", () => {
  it("uses a validated structured candidate only when deterministic amount parsing is unresolved", async () => {
    let interpretationCalls = 0;
    const llm: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret(input) {
        interpretationCalls += 1;
        expect(input).not.toContain("alice@example.com");
        return { intent: "refund_request", entities: { email: null, cardLast4: null, transactionId: null, refundAmount: 40 }, needsClarification: false, clarificationReason: null };
      },
    };
    const agent = new PaylaneAgent({ llm });
    await agent.respond(`${alice} Refund txn_recent_40.`);
    const result = await agent.respond("Please return forty dollars to me.");
    expect(interpretationCalls).toBe(1);
    expect(result.response).toContain("$40.00 refund has been issued");
    expect(agent.store.refunds).toHaveLength(1);
  });

  it("does not call structured extraction or override an explicit deterministic amount", async () => {
    let interpretationCalls = 0;
    const llm: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret() { interpretationCalls += 1; return { intent: "refund_request", entities: { email: null, cardLast4: null, transactionId: null, refundAmount: 40 }, needsClarification: false, clarificationReason: null }; },
    };
    const agent = new PaylaneAgent({ llm });
    const result = await agent.respond(`${alice} Refund $30 for txn_recent_40.`);
    expect(interpretationCalls).toBe(0);
    expect(result.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(result.response).toContain("full original transaction amount");
  });

  it("persists email and card details supplied in separate turns", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("I need a refund.");
    const email = await agent.respond("My email is farah@example.com");
    expect(email.session).toMatchObject({ verified: false, suppliedEmail: "farah@example.com", suppliedCardLast4: null });
    const card = await agent.respond("Here are the last 4 digits: 9876");
    expect(card.session).toMatchObject({ verified: true, customerId: "cus_frozen", suppliedEmail: "farah@example.com", suppliedCardLast4: "9876" });
    expect(card.response).toContain("transaction ID");
  });
});
