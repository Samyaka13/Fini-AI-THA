# Assumptions

- Dates are date-only UTC values. “30 days old” means an age of at least 30 whole UTC calendar days. Tests use `2026-10-12T12:00:00Z` through an injectable clock.
- The four required APIs are mock functions. `get_customer` includes `verified: false` as an initial API value; session verification is never persisted to the customer record.
- `escalate_to_human` accepts `customer_id: null`. This documented schema extension allows a safe anonymous handoff when no matching customer is known; the agent never invents an ID.
- Unauthorized, stolen-card, and account-takeover reports are conservatively treated as suspected fraud because no independent fraud service exists. Amounts above $500 are marked immediate.
- Gemini variables are included for deployment configuration. Local evaluated flows use deterministic routing rather than making external model calls, so all reported scores are reproducible without credentials. A production integration must connect Gemini tool calls only to the same `SafeToolExecutor` boundary.
