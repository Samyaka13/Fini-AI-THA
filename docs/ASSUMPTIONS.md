# Assumptions

- Dates are date-only UTC values. “30 days old” means an age of at least 30 whole UTC calendar days. Tests use `2026-10-12T12:00:00Z` through an injectable clock.
- The four required APIs are mock functions. `get_customer` includes `verified: false` as an initial API value; session verification is never persisted to the customer record.
- `escalate_to_human` accepts `customer_id: null`. This documented schema extension allows a safe anonymous handoff when no matching customer is known; the agent never invents an ID.
- Unauthorized, stolen-card, and account-takeover reports are conservatively treated as suspected fraud because no independent fraud service exists. Amounts above $500 are marked immediate.
- `OPENROUTER_API_KEY` configures `google/gemini-3.8-flash` through OpenRouter. Local evaluation stays provider-free and reproducible. A configured LLM receives only redacted conversation text and cannot execute tools directly; `SafeToolExecutor` remains the only execution boundary.
- A successful partial refund marks its transaction fully refunded for this exercise; a second partial refund is deliberately unsupported.
- A refund amount is accepted only when the customer states it in an unambiguous refund phrase. The transaction's original amount, ID suffixes, dates, and card digits are never treated as a requested refund amount.
