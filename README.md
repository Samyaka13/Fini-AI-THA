# Paylane AI Support Agent

A TypeScript customer-support agent for a fictional fintech app. It uses a single LangGraph workflow and four in-memory mock API tools. Financial and privacy controls are deterministic application code, not prompt-only rules.

## Run

```bash
npm install
cp .env.example .env # optional OpenRouter configuration; no key is needed for local tests
npm run build
npm test
npm run chat
npm run scenarios -- "My email is alice@example.com and my card last four digits are 4242. Refund $40 for txn_recent_40."
```

`npm test` runs unit tests plus all twelve LangGraph scenario tests. It writes sanitized execution transcripts to `artifacts/transcripts/` and refreshes the evaluation report. Set `OPENROUTER_API_KEY` in your local ignored `.env` to use `google/gemini-3.8-flash` through OpenRouter. The graph uses the OpenRouter tool-calling protocol with a four-iteration cap; deterministic verification, ownership, fraud, and refund checks remain authoritative.

`npm run chat` (or `npm start`) starts a continuous terminal conversation. Use `/reset` to begin a new support session or `/exit` to close it.

## Security and extraction model

The agent uses a hybrid interpretation flow. It first deterministically extracts email addresses, card last-four digits, transaction IDs, explicit monetary amounts, and common refund/card intents from the trusted user input. When a value or intent remains genuinely unclear, the OpenRouter client may request a small JSON-only structured interpretation of the already-sanitized message. That result is only a candidate: it is runtime-validated, reconciled with the current session, and never establishes identity, ownership, eligibility, or a successful action. Explicit deterministic evidence wins; unresolved conflicts require clarification.

Verification, transaction ownership, fraud escalation, and all refund decisions are application-enforced. OpenRouter never receives an email address or card last-four value. Terminal graph diagnostics retain their original lifecycle labels but redact trusted input and verification fields.

The current automatic-refund policy is deliberately full-refund-only: the customer must explicitly request the entire original settled charge; the original charge must be positive and no more than $75, less than 30 days old, owned by the verified customer, and not already refunded. Partial requests, larger original charges, and transactions at least 30 days old are not automatically refunded and are routed to a specialist where required.

See `docs/RULEBOOK.md`, `docs/ARCHITECTURE.md`, and `docs/ASSUMPTIONS.md` for behavior and limits.
