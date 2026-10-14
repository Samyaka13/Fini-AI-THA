# Architecture

`PaylaneAgent` invokes a LangGraph workflow with a bounded OpenRouter tool cycle and a response-history node. The cycle records the assistant tool-call message, validates and dispatches allowed requests, appends matching `tool` results, and repeats up to four times before falling back safely.

`agent/openRouter.ts` calls OpenRouter Chat Completions with `google/gemini-3.8-flash` and the four tool schemas. Conversation history redacts email and card-last-four values before provider calls. When local parsing leaves a value-shaped current turn unresolved, a separate structured-extraction request sends only that current raw turn; its runtime-validated result is reconciled as untrusted candidate data before deterministic verification. The LLM can request tools but only `SafeToolExecutor` executes them.

The graph parses the request, runs trusted verification where needed, routes mandatory escalations, obtains an owned transaction, evaluates refund policy, and then reaches the refund execution boundary. `SafeToolExecutor` is the only application path to tools. It checks session verification, ownership, refund eligibility, and suspected fraud again before calling the low-level refund mock.

`MockStore` owns mutable in-memory customer, transaction, refund, and ticket data. Trusted customer records never enter graph responses. Tool traces redact email values and hold only safe result shapes.

`SupportSession.pendingRefund` retains the customer-selected transaction ID and an explicitly stated requested amount across turns. It is updated only from trusted user input. Tool arguments from the model must match this pending state, so a model cannot invent a transaction or amount.
