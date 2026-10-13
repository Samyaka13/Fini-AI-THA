import type { CustomerRecord } from "../domain/customer.js";
import type { SupportSession } from "../domain/session.js";

export type VerificationResult = "missing_details" | "failed" | "verified";

export function verifySession(
  session: SupportSession,
  suppliedEmail: string | null,
  suppliedCardLast4: string | null,
  customer: CustomerRecord | undefined,
): VerificationResult {
  session.suppliedEmail = suppliedEmail;
  session.suppliedCardLast4 = suppliedCardLast4;
  if (!suppliedEmail || !suppliedCardLast4) return "missing_details";
  if (!customer || customer.email.toLowerCase() !== suppliedEmail.toLowerCase() || customer.cardLast4 !== suppliedCardLast4) {
    session.verified = false; session.customerId = null; return "failed";
  }
  session.verified = true; session.customerId = customer.id; return "verified";
}
