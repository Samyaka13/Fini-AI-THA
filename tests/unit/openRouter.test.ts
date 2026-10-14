import { describe, expect, it } from "vitest";
import { OpenRouterClient, sanitizeForLlm } from "../../src/agent/openRouter.js";
import { assessFraud } from "../../src/policy/fraudPolicy.js";

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
    expect(completion.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "get_transaction", arguments: '{"customer_id":"cus_alice","txn_id":"txn_recent_40"}' } }]);
  });

  it("redacts identifiers before a provider call", () => {
    expect(sanitizeForLlm("Email alice@example.com, card last four digits are 4242.")).toBe("Email [account-email], card [card-last-four].");
    expect(sanitizeForLlm("email: alice@example.com cardLast4: 4242")).toBe("email: [account-email] [card-last-four]");
    expect(sanitizeForLlm("4821")).not.toContain("4821");
    expect(sanitizeForLlm("Refund $7500 for txn_1234")).toContain("$7500 for txn_1234");
    expect(sanitizeForLlm("9876 are the last 4 digits of my card")).not.toContain("9876");
  });
  it("uses a minimal raw current turn for runtime-validated structured extraction", async () => {
    let request: RequestInit | undefined;
    const client = new OpenRouterClient("test-key", async (_url, init) => {
      request = init;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ intent: "unknown", entities: { email: "farah@example.com", cardLast4: "9876", transactionId: null, refundAmount: null }, needsClarification: false, clarificationReason: null }) } }] }), { status: 200 });
    });
    const result = await client.interpret("farah@example.com; my card tail code is 9876");
    const body = JSON.parse(String(request?.body));
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1]).toEqual({ role: "user", content: "farah@example.com; my card tail code is 9876" });
    expect(result).toMatchObject({ entities: { email: "farah@example.com", cardLast4: "9876" } });
  });
  it("does not classify a general fraud question as a fraud report", () => {
    expect(assessFraud("How does Paylane prevent fraud?", undefined).suspected).toBe(false);
    expect(assessFraud("I don't recognize this payment.", undefined).suspected).toBe(true);
  });
});
