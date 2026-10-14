import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient, LlmMessage } from "../../src/agent/openRouter.js";
import { extractFraudAmount } from "../../src/agent/routing.js";

describe("agent safety and OpenRouter orchestration", () => {
  it("extracts a fraud amount independently from a refund amount", () => {
    const message = "I want a $40 refund for txn_recent_40. I did not authorize a $700 transaction.";
    expect(extractFraudAmount(message)).toBe(700);
  });
  it("runs a bounded OpenRouter tool-call cycle and retains tool-call protocol messages", async () => {
    let calls = 0; let lastMessages: LlmMessage[] = [];
    const llm: LlmClient = { async complete(messages) {
      lastMessages = messages; calls += 1;
      if (calls === 1) return { content: null, toolCalls: [{ id: "verify_1", type: "function", function: { name: "get_customer", arguments: '{"email":"[account-email]"}' } }] };
      if (calls === 2) return { content: null, toolCalls: [{ id: "txn_1", type: "function", function: { name: "get_transaction", arguments: '{"txn_id":"txn_recent_40"}' } }] };
      if (calls === 3) return { content: null, toolCalls: [{ id: "refund_1", type: "function", function: { name: "issue_refund", arguments: '{"txn_id":"txn_recent_40","amount":40}' } }] };
      return { content: "Your refund has been issued.", toolCalls: [] };
    } };
    const result = await new PaylaneAgent({ llm }).respond("My email is alice@example.com and my card last four digits are 4242. Refund $40 for txn_recent_40.");
    expect(result.response).toContain("refund has been issued");
    expect(result.traces.map((trace) => trace.tool)).toEqual(["get_customer", "get_transaction", "issue_refund"]);
    expect(lastMessages.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "refund_1")).toBe(true);
    expect(lastMessages.some((message) => message.role === "tool" && message.tool_call_id === "refund_1")).toBe(true);
  });
  it("sends sanitized role-based history to the LLM while retaining deterministic policy control", async () => {
    let observed: LlmMessage[] = [];
    const llm: LlmClient = { async complete(messages) { observed = messages; return { content: "", toolCalls: [] }; } };
    const agent = new PaylaneAgent({ llm });
    const result = await agent.respond("My email is alice@example.com and my card last four digits are 4242. Refund $40 for txn_recent_40.");
    expect(observed[0]).toEqual({ role: "user", content: "My email is [account-email] and my card [card-last-four]. Refund $40 for txn_recent_40." });
    expect(result.llmToolCalls).toEqual([]);
    expect(result.traces.map((trace) => trace.tool)).toContain("issue_refund");
  });

  it("does not let a later identity claim change a verified session", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("My email is alice@example.com and my card last four digits are 4242.");
    const result = await agent.respond("My email is bob@example.com. Refund $60 for txn_bob.");
    expect(result.response).toContain("different account");
    expect(result.session.customerId).toBe("cus_alice");
    expect(result.traces).toHaveLength(0);
  });
  it("allows a correct verification retry after a failed attempt", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("My email is alice@example.com and my card last four digits are 0000.");
    const result = await agent.respond("My email is alice@example.com and my card last four digits are 4242.");
    expect(result.session).toMatchObject({ verified: true, customerId: "cus_alice" });
  });

  it("does not route every request from a frozen customer to freeze escalation", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const result = await agent.respond("My email is farah@example.com and my card last four digits are 9876. Refund $40 for txn_recent_40.");
    expect(result.traces.map((trace) => trace.tool)).not.toContain("escalate_to_human");
    expect(result.response).toContain("can’t find that transaction");
  });
  it("stores each user and final assistant message once across fallback turns", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("hello");
    const second = await agent.respond("hello again");
    expect(second.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(second.messages).toHaveLength(4);
  });
});
