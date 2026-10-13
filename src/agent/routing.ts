export function extractEmail(message: string): string | null { return message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null; }
export function extractLast4(message: string): string | null {
  const explicit = message.match(/(?:last\s*(?:four|4)|card)\D{0,12}(\d{4})/i)?.[1];
  return explicit ?? null;
}
export function extractTransactionId(message: string): string | null { return message.match(/txn_[a-z0-9_]+/i)?.[0] ?? null; }
export function extractAmount(message: string): number | undefined {
  const value = message.match(/\$\s*(\d+(?:\.\d{1,2})?)/)?.[1] ?? message.match(/refund\s+(\d+(?:\.\d{1,2})?)/i)?.[1];
  return value ? Number(value) : undefined;
}
export function isRefundRequest(message: string) { return /refund/i.test(message); }
export function isImmediateCancellation(message: string) { return /immediate(?:ly)?|cancel(?:lation)?/i.test(message); }
