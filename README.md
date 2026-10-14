# Paylane AI Support Agent

A TypeScript support agent for a consumer-fintech demo. It supports verified transaction lookups, policy-controlled refunds, card-status support, fraud reporting, and human handoff.

## Set up and run

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env # optional: add OPENROUTER_API_KEY for live LLM responses
npm run build
npm test
npm run chat
```

Use `/reset` in chat to start a new session and `/exit` to quit.

## Commands

```bash
npm run build       # Type-check the project
npm test            # Run unit tests and the 12 evaluation scenarios
npm run chat        # Start the interactive terminal agent
npm run scenarios   # Run the evaluation scenarios and refresh artifacts
```

Add an env file in the route and add open router API key there name of env variable is mentioned in the env example


## Architecture and assumptions

The LangGraph manager owns session state, verification, refund policy, and all tool authorization. The LLM handles natural-language replies and ordinary tool selection, but cannot verify a customer or execute a tool directly. The four mock tools are `get_customer`, `get_transaction`, `issue_refund`, and `escalate_to_human`.

Email and card last-four values must match one trusted record before account details are discussed. Conversation history is redacted for ordinary model calls; accepted verification details remain only in trusted session state. Refunds are full-transaction only: the original settled charge must be $75 or less, under 30 days old, owned by the verified customer, and not previously refunded. Pending, partial, duplicate, over-cap, fraud, and 30-day-or-older cases are safely declined or escalated. Anonymous escalation is allowed with a `null` customer ID, and tests use a fixed clock for date boundaries.
