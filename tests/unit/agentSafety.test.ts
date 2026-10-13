import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient, LlmMessage } from "../../src/agent/openRouter.js";

describe("agent safety and OpenRouter orchestration", () => {
  it("sends sanitized role-based history to the LLM while retaining deterministic policy control", async () => {
    let observed: LlmMessage[] = [];
    const llm: LlmClient = { async complete(messages) { observed = messages; return { content: "", toolCalls: [{ id: "call_1", name: "issue_refund", arguments: { txn_id: "txn_recent_40", amount: 40 } }] }; } };
    const agent = new PaylaneAgent({ llm });
    const result = await agent.respond("My email is alice@example.com and my card last four digits are 4242. Refund $40 for txn_recent_40.");
    expect(observed[0]).toEqual({ role: "user", content: "My email is [account-email] and my card last four [card-last-four]. Refund $40 for txn_recent_40." });
    expect(result.llmToolCalls).toEqual(["issue_refund"]);
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

  it("does not route every request from a frozen customer to freeze escalation", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const result = await agent.respond("My email is farah@example.com and my card last four digits are 9876. Refund $40 for txn_recent_40.");
    expect(result.traces.map((trace) => trace.tool)).not.toContain("escalate_to_human");
    expect(result.response).toContain("can’t find that transaction");
  });
});
