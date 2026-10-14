import { describe, expect, it } from "vitest";
import { PaylaneAgent } from "../../src/agent/graph.js";

const alice = "My email is alice@example.com and my card last four digits are 4242.";
const farah = "My email is farah@example.com and my card last four digits are 9876.";

describe("verified card-status inquiries", () => {
  it("reports an active card from authoritative customer data after a fraud escalation without creating another ticket", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(alice);
    const stolen = await agent.respond("My card was stolen.");
    expect(stolen.traces.map((trace) => trace.tool)).toContain("escalate_to_human");
    const ticketId = agent.store.tickets[0]?.id;
    const status = await agent.respond("I need to know that is my card active or frozen?");
    expect(status.response).toContain("card as active");
    expect(status.response).toContain(ticketId!);
    expect(status.traces.map((trace) => trace.tool)).toEqual(["get_customer"]);
    expect(status.traces.map((trace) => trace.tool)).not.toContain("escalate_to_human");
    expect(agent.store.tickets).toHaveLength(1);
  });

  it("recognizes spelling variations and reports frozen status without inventing a reason", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(farah);
    const status = await agent.respond("I want to know that my card is freezen or active?");
    expect(status.response).toContain("card as frozen");
    expect(status.response).toContain("can’t access the reason");
    expect(status.traces.map((trace) => trace.tool)).toEqual(["get_customer", "escalate_to_human"]);
  });

  it("handles usable-card wording from the authoritative status", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(alice);
    const status = await agent.respond("Can I use my card?");
    expect(status.response).toContain("card as active");
    expect(status.traces.map((trace) => trace.tool)).toEqual(["get_customer"]);
  });

  it("escalates unavailable status once and reuses the confirmed ticket on a follow-up", async () => {
    const agent = new PaylaneAgent({ llm: null });
    await agent.respond(alice);
    const customer = agent.store.findCustomerById("cus_alice");
    if (!customer) throw new Error("missing seeded customer");
    (customer as { status: string }).status = "unavailable";
    const first = await agent.respond("Is my card blocked?");
    expect(first.response).toContain("can’t currently confirm");
    expect(first.traces.map((trace) => trace.tool)).toEqual(["get_customer", "escalate_to_human"]);
    const ticketId = agent.store.tickets[0]?.id;
    const followUp = await agent.respond("Is my card frozen?");
    expect(followUp.response).toContain(ticketId!);
    expect(followUp.traces.map((trace) => trace.tool)).toEqual(["get_customer"]);
    expect(agent.store.tickets).toHaveLength(1);
  });
});
