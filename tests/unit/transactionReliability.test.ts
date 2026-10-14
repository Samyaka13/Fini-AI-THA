import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient } from "../../src/agent/openRouter.js";

const alice = "My email is alice@example.com and my card last four digits are 4242.";

describe("transaction inquiry and refund workflow reliability", () => {
  it("preserves refund intent after a bad transaction ID and accepts a corrected ID", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("refund");
    const invalid = await agent.respond(`${alice} Refund txn_recent_30.`);
    expect(invalid.response).toContain("check the transaction ID");
    expect(invalid.session).toMatchObject({ verified: true, customerId: "cus_alice", pendingRefund: { transactionId: null, requestedAmount: null } });
    const corrected = await agent.respond("txn_recent_40");
    expect(corrected.response).toContain("What refund amount");
    expect(corrected.session.pendingRefund).toEqual({ transactionId: "txn_recent_40", requestedAmount: null });
    expect(corrected.traces.map((trace) => trace.tool)).toEqual(["get_transaction"]);
  });

  it("supports verified read-only transaction inquiries without starting a refund", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(alice);
    const result = await agent.respond("I want to know about a transaction txn_exact_75");
    expect(result.traces.map((trace) => trace.tool)).toEqual(["get_transaction"]);
    expect(result.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(result.response).toContain("$75.00");
    expect(result.response).toContain("No refund has been issued");
    expect(result.session.pendingRefund).toBeNull();
  });

  it("returns an authoritative not-found result without substituting an earlier transaction", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(alice);
    const result = await agent.respond("What about txn_exact_7?");
    expect(result.traces).toContainEqual(expect.objectContaining({ tool: "get_transaction", result: { found: false, reason: "not_found_or_not_owned" } }));
    expect(result.response).toContain("can’t find that transaction");
    expect(result.response).not.toContain("Metro Market");
  });

  it("retrieves refund status from the stored record and never issues a second refund", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const issued = await agent.respond(`${alice} Refund $40 for txn_recent_40.`);
    const refundId = agent.store.refunds[0]?.id;
    expect(issued.traces.map((trace) => trace.tool)).toContain("issue_refund");
    expect(refundId).toBeDefined();
    const requestId = await agent.respond("Look into my refunds");
    expect(requestId.response).toContain("transaction ID");
    const status = await agent.respond("txn_recent_40");
    expect(status.traces.map((trace) => trace.tool)).toEqual(["get_transaction"]);
    expect(status.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(status.response).toContain(`reference ${refundId}`);
    expect(status.response).toContain("$40.00");
    expect(agent.store.refunds).toHaveLength(1);
  });

  it("does not execute a refund before an explicit amount and retains only per-turn traces", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const missingAmount = await agent.respond(`${alice} Refund txn_recent_40.`);
    expect(missingAmount.response).toContain("What refund amount");
    expect(missingAmount.traces.map((trace) => trace.tool)).toEqual(["get_customer", "get_transaction"]);
    expect(missingAmount.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    const issued = await agent.respond("40");
    expect(issued.traces.map((trace) => trace.tool)).toEqual(["issue_refund"]);
  });

  it("does not approve over-amount old refunds and records the amount mismatch in escalation", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const result = await agent.respond(`${alice} Refund $50 for txn_exact_30.`);
    expect(result.traces.map((trace) => trace.tool)).toContain("escalate_to_human");
    expect(result.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(result.response).toContain("exceeds the original transaction amount");
    expect(result.response).toContain("30 days old or older");
    expect(result.traces).toContainEqual(expect.objectContaining({ tool: "escalate_to_human", args: expect.objectContaining({ summary: expect.stringContaining("exceeds original transaction amount") }) }));
  });

  it("escalates a smaller request against a large original charge instead of splitting it", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const result = await agent.respond(`${alice} Refund $60 for txn_over_cap.`);
    expect(result.traces.map((trace) => trace.tool)).toContain("escalate_to_human");
    expect(result.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(result.response).toContain("above $75");
    expect(result.response).toContain("full original transaction amount");
  });

  it("records malformed model transaction calls and does not convert them into a refund-status claim", async () => {
    let call = 0;
    const llm: LlmClient = {
      async complete() {
        call += 1;
        if (call === 1) return { content: null, toolCalls: [{ id: "wrong_txn", type: "function", function: { name: "get_transaction", arguments: '{"txn_id":"txn_bob"}' } }] };
        return { content: "That transaction has already been refunded.", toolCalls: [] };
      },
    };
    const agent = new PaylaneAgent({ llm });
    const result = await agent.respond(`${alice} Refund txn_recent_40.`);
    expect(result.traces).toContainEqual(expect.objectContaining({ tool: "get_transaction", result: { ok: false, reason: "invalid_transaction_request" } }));
    expect(result.response).toContain("What refund amount");
    expect(result.response).not.toContain("already been refunded");
    expect(agent.store.refunds).toHaveLength(0);
  });
});
