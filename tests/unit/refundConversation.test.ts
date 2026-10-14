import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient } from "../../src/agent/openRouter.js";

describe("multi-turn refund state", () => {
  it("retains transaction context, asks for an explicit amount, then issues a valid full refund", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const first = await agent.respond("refund me");
    expect(first.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    const second = await agent.respond("emailid: alice@example.com LAST four digits of card: 4242 transaction id: txn_recent_40");
    expect(second.response).toContain("What refund amount");
    expect(second.session.pendingRefund).toEqual({ transactionId: "txn_recent_40", requestedAmount: null });
    expect(second.traces.map((trace) => trace.tool)).toContain("get_transaction");
    expect(second.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    const third = await agent.respond("40 is the amount I want to be refunded");
    expect(third.response).toContain("$40.00 refund has been issued");
    expect(third.traces).toContainEqual(expect.objectContaining({ tool: "issue_refund", result: expect.objectContaining({ ok: true }) }));
    expect(third.session.pendingRefund).toBeNull();
    expect(agent.store.refunds).toHaveLength(1);
    expect(agent.store.findTransaction("txn_recent_40")?.status).toBe("refunded");
  });

  it("traces an LLM refund attempt that does not match a customer-supplied amount", async () => {
    const llm: LlmClient = { async complete() { return { content: null, toolCalls: [{ id: "bad_refund", type: "function", function: { name: "issue_refund", arguments: '{"txn_id":"txn_recent_40","amount":40}' } }] }; } };
    const agent = new PaylaneAgent({ llm });
    const result = await agent.respond("My email is alice@example.com and my card last four digits are 4242. Refund txn_recent_40.");
    expect(result.traces).toContainEqual(expect.objectContaining({ tool: "issue_refund", result: { ok: false, reason: "refund_arguments_must_match_pending_request" } }));
    expect(result.response).toContain("What refund amount");
  });

  it("does not reuse a cleared pending refund after escalation", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const escalated = await agent.respond("My email is alice@example.com and my card last four digits are 4242. Refund $120 for txn_over_cap.");
    expect(escalated.traces.map((trace) => trace.tool)).toContain("escalate_to_human");
    expect(escalated.session.pendingRefund).toBeNull();
    const followUp = await agent.respond("What happens now?");
    expect(followUp.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    expect(followUp.traces.map((trace) => trace.tool)).not.toContain("escalate_to_human");
  });

  it("accepts a bare amount response and does not repeat verification or transaction lookup", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("refund my money");
    const details = await agent.respond("email: alice@example.com cardLast4: 4242 transaction_id: txn_recent_40");
    expect(details.traces.map((trace) => trace.tool)).toEqual(["get_customer", "get_transaction"]);
    const amount = await agent.respond("40");
    expect(amount.response).toContain("$40.00 refund has been issued");
    expect(amount.traces.map((trace) => trace.tool)).toEqual(["issue_refund"]);
  });

  it("does not turn ambiguous, invalid, or unrelated numbers into an automatic refund", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("refund my money");
    await agent.respond("email: alice@example.com last four digits of card: 4242 transaction id: txn_recent_40");
    const ambiguous = await agent.respond("Refund $30 or $40 back");
    expect(ambiguous.response).toContain("What refund amount");
    expect(ambiguous.traces.map((trace) => trace.tool)).not.toContain("issue_refund");
    const invalid = await agent.respond("$0");
    expect(invalid.response).toContain("What refund amount");
    expect(invalid.session.pendingRefund?.requestedAmount).toBeNull();
    expect(agent.store.refunds).toHaveLength(0);
  });

  it("clears a pending refund when the customer cancels it", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("refund txn_recent_40");
    const cancelled = await agent.respond("cancel my refund request");
    expect(cancelled.session.pendingRefund).toBeNull();
  });

  it("does not execute redundant model-selected verification or lookup tools after they are complete", async () => {
    let call = 0;
    const llm: LlmClient = {
      async complete() {
        call += 1;
        if (call === 1) return { content: "", toolCalls: [] };
        if (call === 2) return { content: null, toolCalls: [{ id: "repeat_verify", type: "function", function: { name: "get_customer", arguments: '{"email":"[account-email]"}' } }] };
        if (call === 3) return { content: null, toolCalls: [{ id: "repeat_txn", type: "function", function: { name: "get_transaction", arguments: '{"txn_id":"txn_recent_40"}' } }] };
        return { content: "", toolCalls: [] };
      },
    };
    const agent = new PaylaneAgent({ llm });
    await agent.respond("Refund txn_recent_40. My email is alice@example.com and my card last four digits are 4242.");
    const amount = await agent.respond("40");
    expect(amount.response).toContain("$40.00 refund has been issued");
    expect(amount.traces.map((trace) => trace.tool)).toEqual(["issue_refund"]);
    expect(amount.messages.some((message) => message.role === "tool" && message.tool_call_id === "repeat_verify" && message.content.includes("already_verified"))).toBe(true);
    expect(amount.messages.some((message) => message.role === "tool" && message.tool_call_id === "repeat_txn" && message.content.includes("already_loaded"))).toBe(true);
  });
});
