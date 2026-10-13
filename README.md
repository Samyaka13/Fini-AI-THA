# Paylane AI Support Agent

A TypeScript customer-support agent for a fictional fintech app. It uses a single LangGraph workflow and four in-memory mock API tools. Financial and privacy controls are deterministic application code, not prompt-only rules.

## Run

```bash
npm install
cp .env.example .env # optional Gemini configuration; no key is needed for local tests
npm run build
npm test
npm run scenarios -- "My email is alice@example.com and my card last four digits are 4242. Refund $40 for txn_recent_40."
```

`npm test` runs unit tests plus all twelve LangGraph scenario tests. It writes sanitized execution transcripts to `artifacts/transcripts/` and refreshes the evaluation report. The optional `GOOGLE_API_KEY` and `GEMINI_MODEL` values reserve the project configuration for Gemini via LangChain; the checked-in test workflow intentionally uses deterministic intent routing so safety assertions are reproducible without external credentials.

See `docs/RULEBOOK.md`, `docs/ARCHITECTURE.md`, and `docs/ASSUMPTIONS.md` for behavior and limits.
