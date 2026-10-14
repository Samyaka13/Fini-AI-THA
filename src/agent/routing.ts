import { assessFraud } from "../policy/fraudPolicy.js";

export type SupportIntent = "refund_request" | "transaction_lookup" | "refund_status" | "card_status" | "frozen_card_help" | "fraud_report" | "human_escalation" | "account_closure" | "legal_action" | "unknown";

export function extractEmail(message: string): string | null { return message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null; }
export function extractLast4(message: string): string | null {
  const descriptorFirst = /(?:last\s*(?:four|4)\s*(?:digits?|numbers?)?|card[\s_-]*last\s*4)\D{0,24}\b(\d{4})\b/i.exec(message)?.[1];
  const cardEndsIn = /\b(?:my\s+)?card(?:'s)?\s+(?:ends\s+in|last\s*(?:four|4)\s*(?:digits?|numbers?))\s*(?:are|is|:)?\s*(\d{4})\b/i.exec(message)?.[1];
  const numberFirst = /\b(\d{4})\b\s+(?:are|is)\s+(?:the\s+)?last\s*(?:four|4)\s*(?:digits?|numbers?)\s+(?:of|on)\s+(?:my\s+)?card\b/i.exec(message)?.[1];
  return descriptorFirst ?? cardEndsIn ?? numberFirst ?? (message.trim().match(/^\d{4}$/)?.[0] ?? null);
}
export function extractTransactionId(message: string): string | null { return message.match(/txn_[a-z0-9_]+/i)?.[0] ?? null; }
const money = /\$\s*(\d+(?:\.\d{1,2})?)/g;
const asAmount = (value: string | undefined) => value === undefined ? undefined : Number(value);
/**
 * Extracts an explicitly stated refund amount.  A bare number is intentionally
 * excluded by default: it is only meaningful while a trusted pending request is
 * already waiting for an amount (see graph.ts).
 */
export function extractRefundAmount(message: string, options: { allowBareAmount?: boolean } = {}): number | undefined {
  const matches = [
    ...message.matchAll(/\brefund(?:\s+(?:of|for))?\s*\$\s*(\d+(?:\.\d{1,2})?)/gi),
    ...message.matchAll(/\brefund(?:\s+(?:of|for))?\s+\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)\b/gi),
    ...message.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:refund|back)\b/gi),
    ...message.matchAll(/\b(\d+(?:\.\d{1,2})?)\s+is\s+(?:the\s+)?amount\s+i\s+want\s+(?:to\s+be\s+)?refunded\b/gi),
    ...message.matchAll(/\brefund\s+(?:i\s+am\s+)?requesting\s+(?:is\s+)?\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)?\b/gi),
    ...message.matchAll(/\bi\s+want\s+\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)?\s+refunded\b/gi),
  ].map((match) => asAmount(match[1])).filter((value): value is number => value !== undefined && Number.isFinite(value));
  // A dollar sign makes a single-value response explicit even before a pending
  // request exists. Plain numbers remain contextual to avoid treating IDs/card
  // details as money.
  const loneDollarAmount = message.match(/^\s*\$\s*(\d+(?:\.\d{1,2})?)\s*[.!?]?\s*$/);
  if (loneDollarAmount) matches.push(Number(loneDollarAmount[1]));
  if (options.allowBareAmount && /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:dollars?|usd)?\s*[.!?]?\s*$/i.test(message)) {
    const bare = Number(message.match(/^\s*\$?\s*(\d+(?:\.\d{1,2})?)/)?.[1]);
    if (Number.isFinite(bare)) matches.push(bare);
  }
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}
export function isRefundCancellation(message: string): boolean { return /\b(?:cancel|withdraw)\s+(?:my\s+)?refund(?:\s+request)?\b/i.test(message); }
export function isRefundStatusInquiry(message: string): boolean { return /\b(?:refund\s+status|status\s+of\s+(?:my\s+)?refund|look\s+into\s+(?:my\s+)?refunds?)\b/i.test(message); }
export function isTransactionInquiry(message: string): boolean {
  return isRefundStatusInquiry(message) || Boolean(extractTransactionId(message)) || /\b(?:transaction|charge|payment)\s+(?:status|details?|information)\b/i.test(message);
}
export function isCardStatusInquiry(message: string): boolean {
  return /\b(?:what(?:'s|\s+is)|(?:i\s+)?(?:need|want)\s+(?:help\s+)?(?:to\s+)?know|help)\s+(?:with\s+)?(?:the\s+)?status\s+of\s+(?:my\s+|the\s+)?card\b|\b(?:my\s+)?card\s+status\b|\b(?:is|has)\s+(?:my\s+)?card\s+(?:is\s+)?(?:active|frozen|freezen|blocked)\b|\b(?:my\s+)?card\s+(?:is\s+)?(?:active|frozen|freezen|blocked)\b|\bcan\s+i\s+use\s+(?:my\s+)?card\b|\b(?:active|frozen|freezen|blocked)\s+or\s+(?:active|frozen|freezen|blocked)\b/i.test(message);
}
export function isHumanEscalationRequest(message: string): boolean { return /\b(?:speak|talk|connect)\s+(?:to|with)\s+(?:a\s+)?(?:human|person|agent|representative)|\bhuman\s+(?:support|help|agent)\b/i.test(message); }
export function extractFraudAmount(message: string): number | undefined { const clauses = message.split(/[.!?;]+/).filter((clause) => /unauthori[sz]ed|never made|didn['’]t authori[sz]e|did not authori[sz]e|without permission|don['’]t recognize|stolen|take.?over/i.test(clause)); const values = clauses.flatMap((clause) => [...clause.matchAll(money)].map((match) => Number(match[1]))).filter(Number.isFinite); return values.length === 1 ? values[0] : undefined; }
export function isRefundRequest(message: string) { return !isRefundStatusInquiry(message) && /\brefund\b/i.test(message); }
export function isImmediateCancellation(message: string) { return !/\b(?:do not|don['’]t)\s+cancel\b/i.test(message) && /\b(?:immediate(?:ly)?|cancel(?:lation)?)\b/i.test(message); }
export function isFrozenCardRequest(message: string) { return !/\bnot\s+frozen\b/i.test(message) && /\b(?:unfreeze|freeze\s+reason|reason\s+(?:for|my)\s*(?:the\s+)?(?:freeze|frozen)|why\s+(?:is\s+)?(?:my\s+)?card\s+frozen)\b/i.test(message); }
export function isLegalAction(message: string) { return /\b(?:legal action|lawyer|attorney|sue|lawsuit)\b/i.test(message); }
export function isAccountClosure(message: string) { return /\b(?:close|closure)\s+(?:my\s+)?account\b/i.test(message); }

/**
 * Small, intentionally conservative routing layer.  The structured model is
 * consulted only when this returns unknown; it cannot overrule explicit user
 * language such as a refund-status or fraud report.
 */
export function deterministicIntent(message: string): SupportIntent {
  if (assessFraud(message, extractFraudAmount(message)).suspected) return "fraud_report";
  if (isLegalAction(message)) return "legal_action";
  if (isAccountClosure(message)) return "account_closure";
  if (isHumanEscalationRequest(message)) return "human_escalation";
  if (isRefundStatusInquiry(message)) return "refund_status";
  if (isFrozenCardRequest(message)) return "frozen_card_help";
  if (isCardStatusInquiry(message)) return "card_status";
  if (isRefundRequest(message)) return "refund_request";
  if (isTransactionInquiry(message)) return "transaction_lookup";
  return "unknown";
}
