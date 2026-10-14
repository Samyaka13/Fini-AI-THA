import { describe, expect, it } from "vitest";
import { extractEmail, extractLast4, extractRefundAmount, isHumanEscalationRequest } from "../../src/agent/routing.js";

describe("refund amount extraction", () => {
  it("recognizes explicit refund amounts without reading identifier or card digits", () => {
    expect(extractRefundAmount("I want a refund of $30")).toBe(30);
    expect(extractRefundAmount("30 is the amount I want to be refunded")).toBe(30);
    expect(extractRefundAmount("Refund $30 for txn_recent_40")).toBe(30);
    expect(extractRefundAmount("$30")).toBe(30);
    expect(extractRefundAmount("txn_recent_40")).toBeUndefined();
    expect(extractRefundAmount("last four digits of card: 4242")).toBeUndefined();
    expect(extractRefundAmount("2026-10-12")).toBeUndefined();
  });

  it("does not guess when multiple candidate refund amounts are present", () => {
    expect(extractRefundAmount("Refund $30 or $40 back")).toBeUndefined();
  });

  it("accepts bare answers only when the caller is collecting a refund amount", () => {
    expect(extractRefundAmount("30")).toBeUndefined();
    expect(extractRefundAmount("30 dollars")).toBeUndefined();
    expect(extractRefundAmount("30", { allowBareAmount: true })).toBe(30);
    expect(extractRefundAmount("30 dollars", { allowBareAmount: true })).toBe(30);
    expect(extractRefundAmount("Refund I am requesting is 30 dollars")).toBe(30);
    expect(extractRefundAmount("I want 30 dollars refunded")).toBe(30);
  });

  it("extracts common verification phrasing without confusing transaction-ID digits for money", () => {
    expect(extractEmail("My email is farah@example.com")).toBe("farah@example.com");
    expect(extractLast4("The last four digits are 9876")).toBe("9876");
    expect(extractLast4("Here are the last 4 digits: 9876")).toBe("9876");
    expect(extractRefundAmount("txn_recent_40")).toBeUndefined();
    expect(isHumanEscalationRequest("Let me speak to a human")).toBe(true);
  });

  it("recognizes explicit descriptor-first and number-first card-last-four wording", () => {
    expect(extractLast4("9876")).toBe("9876");
    expect(extractLast4("9876 are the last 4 digits of my card")).toBe("9876");
    expect(extractLast4("9876 is the last four digits of my card")).toBe("9876");
    expect(extractLast4("The last 4 digits of my card are 9876")).toBe("9876");
    expect(extractLast4("My card ends in 9876")).toBe("9876");
    expect(extractLast4("My card's last four digits are 9876")).toBe("9876");
    expect(extractLast4("The last four numbers on my card are 9876")).toBe("9876");
    expect(extractLast4("cardLast4: 9876")).toBe("9876");
    expect(extractLast4("Refund $40 for txn_recent_40")).toBeNull();
  });
});
