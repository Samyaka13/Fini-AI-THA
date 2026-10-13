import type { GetCustomerResult } from "../domain/customer.js";
import type { SupportSession } from "../domain/session.js";


export interface VerificationEvaluation { result: "missing_details" | "failed" | "verified"; session: SupportSession; }

export function verifySession(
  session: SupportSession,
  suppliedEmail: string | null,
  suppliedCardLast4: string | null,
  customer: GetCustomerResult,
): VerificationEvaluation {
  const next = { ...session, suppliedEmail, suppliedCardLast4 };
  if (!suppliedEmail || !suppliedCardLast4) return { result: "missing_details", session: next };
  if (!customer.found || customer.card_last4 !== suppliedCardLast4) {
    return { result: "failed", session: { ...next, verified: false, customerId: null } };
  }
  return { result: "verified", session: { ...next, verified: true, customerId: customer.id } };
}
