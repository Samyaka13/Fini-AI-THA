export function extractEmail(message: string): string | null { return message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null; }
export function extractLast4(message: string): string | null { return message.match(/(?:last\s*(?:four|4)|card)\D{0,12}(\d{4})/i)?.[1] ?? (message.trim().match(/^\d{4}$/)?.[0] ?? null); }
export function extractTransactionId(message: string): string | null { return message.match(/txn_[a-z0-9_]+/i)?.[0] ?? null; }
const money = /\$\s*(\d+(?:\.\d{1,2})?)/g;
const asAmount = (value: string | undefined) => value === undefined ? undefined : Number(value);
export function extractRefundAmount(message: string): number | undefined { const match = /refund(?:\s+(?:of|for))?\s*\$\s*(\d+(?:\.\d{1,2})?)/i.exec(message) ?? /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:refund|back)/i.exec(message); return asAmount(match?.[1]); }
export function extractFraudAmount(message: string): number | undefined { const clauses = message.split(/[.!?;]+/).filter((clause) => /unauthori[sz]ed|never made|didn['’]t authori[sz]e|did not authori[sz]e|without permission|don['’]t recognize|stolen|take.?over/i.test(clause)); const values = clauses.flatMap((clause) => [...clause.matchAll(money)].map((match) => Number(match[1]))).filter(Number.isFinite); return values.length === 1 ? values[0] : undefined; }
export function isRefundRequest(message: string) { return /\brefund\b/i.test(message); }
export function isImmediateCancellation(message: string) { return !/\b(?:do not|don['’]t)\s+cancel\b/i.test(message) && /\b(?:immediate(?:ly)?|cancel(?:lation)?)\b/i.test(message); }
export function isFrozenCardRequest(message: string) { return !/\bnot\s+frozen\b/i.test(message) && /\b(?:frozen|unfreeze|freeze reason)\b/i.test(message); }
export function isLegalAction(message: string) { return /\b(?:legal action|lawyer|attorney|sue|lawsuit)\b/i.test(message); }
export function isAccountClosure(message: string) { return /\b(?:close|closure)\s+(?:my\s+)?account\b/i.test(message); }
