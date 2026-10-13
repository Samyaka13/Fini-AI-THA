# Architecture

`PaylaneAgent` invokes a three-node LangGraph workflow: OpenRouter LLM intent/tool request, deterministic policy and tool execution, then assistant-response history. Role-based messages, verification state, LLM requests, and sanitized tool traces remain separate.

`agent/openRouter.ts` calls OpenRouter Chat Completions with `google/gemini-3.8-flash` and the four tool schemas. Email and card-last-four values are redacted before the provider call. The LLM can request tools but only `SafeToolExecutor` executes them.

The graph parses the request, runs trusted verification where needed, routes mandatory escalations, obtains an owned transaction, evaluates refund policy, and then reaches the refund execution boundary. `SafeToolExecutor` is the only application path to tools. It checks session verification, ownership, refund eligibility, and suspected fraud again before calling the low-level refund mock.

`MockStore` owns mutable in-memory customer, transaction, refund, and ticket data. Trusted customer records never enter graph responses. Tool traces redact email values and hold only safe result shapes.
