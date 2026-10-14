import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";
import type { LlmClient } from "../../src/agent/openRouter.js";
import { deterministicIntent, isCardStatusInquiry, isFrozenCardRequest } from "../../src/agent/routing.js";

describe("trusted verification pipeline", () => {
  it("retains split details and verifies the original card-status conversation before any model call", async () => {
    let completionCalls = 0;
    const llm: LlmClient = {
      async complete() { completionCalls += 1; return { content: "", toolCalls: [] }; },
    };
    const agent = new PaylaneAgent({ llm });

    const opening = await agent.respond("I need help with the status of the card");
    expect(opening.response).toContain("account email");
    const email = await agent.respond("farah@example.com is my email");
    expect(email.session).toMatchObject({ verified: false, suppliedEmail: "farah@example.com", suppliedCardLast4: null });

    const card = await agent.respond("9876");
    expect(card.session).toMatchObject({
      suppliedEmail: "farah@example.com",
      suppliedCardLast4: "9876",
      verified: true,
      customerId: "cus_frozen",
      pendingCardIntent: null,
    });
    expect(card.response).toContain("card as frozen");
    expect(card.response).not.toMatch(/provide.*(?:email|four digits)/i);
    expect(card.llmToolCalls).toEqual([]);
    expect(completionCalls).toBe(0);
    expect(card.traces.every((trace) => !Object.values(trace.args).includes("[account-email]"))).toBe(true);
  });

  it("verifies a complete single-turn pair and never stores redacted placeholders", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const result = await agent.respond("email: farah@example.com, cardLast4: 9876");
    expect(result.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "9876", verified: true, customerId: "cus_frozen" });

    const blank = new PaylaneAgent({ llm: null });
    const placeholders = await blank.respond("[account-email] [card-last-four]");
    expect(placeholders.session).toMatchObject({ suppliedEmail: null, suppliedCardLast4: null, verified: false, customerId: null });
  });

  it("also retains card digits that arrive before the email", async () => {
    const agent = new PaylaneAgent({ llm: null });
    const digits = await agent.respond("9876");
    expect(digits.session).toMatchObject({ suppliedEmail: null, suppliedCardLast4: "9876", verified: false });
    const email = await agent.respond("farah@example.com");
    expect(email.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "9876", verified: true, customerId: "cus_frozen" });
  });

  it.each([
    "9876 are the last 4 digits of my card",
    "The last four digits of my card are 9876",
  ])("verifies explicit card detail wording: %s", async (cardDetail) => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("farah@example.com is my email");
    const result = await agent.respond(cardDetail);
    expect(result.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "9876", verified: true, customerId: "cus_frozen" });
  });

  it("uses a raw current-turn structured candidate when deterministic card parsing cannot interpret the wording", async () => {
    let extractionInput = "";
    const llm: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret(input) {
        extractionInput = input;
        return { intent: "unknown", entities: { email: null, cardLast4: "9876", transactionId: null, refundAmount: null }, needsClarification: false, clarificationReason: null };
      },
    };
    const agent = new PaylaneAgent({ llm });
    await agent.respond("farah@example.com is my email");
    const result = await agent.respond("My card tail code is 9876");
    expect(extractionInput).toBe("My card tail code is 9876");
    expect(result.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "9876", verified: true, customerId: "cus_frozen" });
    expect(result.messages.some((message) => message.role === "user" && message.content.includes("9876"))).toBe(false);
  });

  it("merges partial candidates, accepts a pre-verification correction, and keeps failed details unverified", async () => {
    const corrected = new PaylaneAgent({ llm: null });
    await corrected.respond("email: alice@example.com");
    const emailCorrection = await corrected.respond("Actually my email is farah@example.com");
    expect(emailCorrection.session.suppliedEmail).toBe("farah@example.com");
    const verified = await corrected.respond("9876");
    expect(verified.session).toMatchObject({ verified: true, customerId: "cus_frozen", suppliedEmail: "farah@example.com", suppliedCardLast4: "9876" });

    const mismatch = new PaylaneAgent({ llm: null });
    await mismatch.respond("farah@example.com");
    const failed = await mismatch.respond("last four digits: 4242");
    expect(failed.session).toMatchObject({ verified: false, customerId: null, suppliedEmail: "farah@example.com", suppliedCardLast4: "4242" });
    const absentField = await mismatch.respond("I still need help");
    expect(absentField.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "4242" });
  });

  it("does not silently switch a verified identity", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("email: alice@example.com cardLast4: 4242");
    const changed = await agent.respond("email: farah@example.com cardLast4: 9876");
    expect(changed.session).toMatchObject({ verified: true, customerId: "cus_alice", suppliedEmail: "alice@example.com", suppliedCardLast4: "4242" });
    expect(changed.response).toContain("different account");
  });

  it("rejects conflicting structured candidates and accepts explicit unverified card corrections", async () => {
    const conflictLlm: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret() { return { intent: "unknown", entities: { email: null, cardLast4: "1234", transactionId: null, refundAmount: null }, needsClarification: false, clarificationReason: null }; },
    };
    const conflict = new PaylaneAgent({ llm: conflictLlm });
    const rejected = await conflict.respond("invalid@ is my email; the last four digits of my card are 9876");
    expect(rejected.response).toContain("conflicting card last four");
    expect(rejected.session).toMatchObject({ suppliedEmail: null, suppliedCardLast4: null, verified: false });

    const correction = new PaylaneAgent({ llm: null });
    await correction.respond("farah@example.com, last four digits: 0000");
    const corrected = await correction.respond("Actually, my card's last four digits are 9876");
    expect(corrected.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: "9876", verified: true, customerId: "cus_frozen" });
  });

  it("ignores malformed structured responses and null entity fields without erasing stored details", async () => {
    const malformed: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret() { return { intent: "unknown", entities: { email: null, cardLast4: null, transactionId: null, refundAmount: null }, needsClarification: "no" as unknown as boolean, clarificationReason: null }; },
    };
    const agent = new PaylaneAgent({ llm: malformed });
    const first = await agent.respond("farah@example.com");
    expect(first.session.suppliedEmail).toBe("farah@example.com");
    const later = await agent.respond("My card tail code is 9876");
    expect(later.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: null, verified: false });
  });

  it("does not let valid null structured fields erase previously collected candidates", async () => {
    const nullEntities: LlmClient = {
      async complete() { return { content: "", toolCalls: [] }; },
      async interpret() { return { intent: "unknown", entities: { email: null, cardLast4: null, transactionId: null, refundAmount: null }, needsClarification: false, clarificationReason: null }; },
    };
    const agent = new PaylaneAgent({ llm: nullEntities });
    await agent.respond("farah@example.com");
    const result = await agent.respond("My card tail code is 9876");
    expect(result.session).toMatchObject({ suppliedEmail: "farah@example.com", suppliedCardLast4: null, verified: false });
  });

  it("answers a later card-status request from the verified record without restarting verification or a refund", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond("email: farah@example.com cardLast4: 9876");
    const status = await agent.respond("I need help with the status of the card");
    expect(status.response).toContain("card as frozen");
    expect(status.session.pendingRefund).toBeNull();
    expect(status.traces).toContainEqual(expect.objectContaining({ tool: "get_customer", args: { customer_id: "[verified-session]" } }));
    expect(status.traces).not.toContainEqual(expect.objectContaining({ tool: "get_customer", args: { email: "[redacted]" } }));
  });
});

describe("card-status classification", () => {
  const variants = [
    "I need help with the status of the card.",
    "What is my card status?",
    "I want to know the status of my card.",
    "Is my card active?",
    "Is my card frozen?",
    "Is my card blocked?",
    "Can I use my card?",
  ];

  it.each(variants)("routes %s as a general card-status inquiry", (message) => {
    expect(isCardStatusInquiry(message)).toBe(true);
    expect(deterministicIntent(message)).toBe("card_status");
  });

  it("keeps freeze-reason and unfreeze requests distinct from a status check", () => {
    expect(isFrozenCardRequest("Why is my card frozen?")).toBe(true);
    expect(isFrozenCardRequest("Please unfreeze my card")).toBe(true);
    expect(isFrozenCardRequest("Is my card frozen?")).toBe(false);
  });
});
