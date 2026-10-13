import { describe, expect, it } from "vitest";
import { OpenRouterClient, sanitizeForLlm } from "../../src/agent/openRouter.js";

describe("OpenRouter integration", () => {
  it("uses the configured Gemini model, tool schemas, and parses a tool call", async () => {
    let request: RequestInit | undefined;
    const client = new OpenRouterClient("test-key", async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "call_1", function: { name: "get_transaction", arguments: '{"customer_id":"cus_alice","txn_id":"txn_recent_40"}' } }] } }] }), { status: 200 });
    });
    const completion = await client.complete([{ role: "user", content: "Please help" }]);
    const body = JSON.parse(String(request?.body));
    expect(request?.headers).toMatchObject({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.tools).toHaveLength(4);
    expect(completion.toolCalls).toEqual([{ id: "call_1", name: "get_transaction", arguments: { customer_id: "cus_alice", txn_id: "txn_recent_40" } }]);
  });

  it("redacts identifiers before a provider call", () => {
    expect(sanitizeForLlm("Email alice@example.com, card last four digits are 4242.")).toBe("Email [account-email], card last four [card-last-four].");
  });
});
