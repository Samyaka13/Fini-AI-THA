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

See `docs/RULEBOOK.md`, `docs/ARCHITECTURE.md`, and `docs/ASSUMPTIONS.md` for behavior and limits.
