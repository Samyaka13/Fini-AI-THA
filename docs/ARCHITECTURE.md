# Architecture

`PaylaneAgent` invokes a compiled single-node LangGraph `StateGraph` for every customer turn. Graph state separates messages, the session, response, and sanitized tool traces. `agent/gemini.ts` provides the LangChain Gemini tool-calling binding for a deployed conversational layer. Its tool declarations never call raw store APIs; a deployment must dispatch every call through the same safe executor.

The graph parses the request, runs trusted verification where needed, routes mandatory escalations, obtains an owned transaction, evaluates refund policy, and then reaches the refund execution boundary. `SafeToolExecutor` is the only application path to tools. It checks session verification, ownership, refund eligibility, and suspected fraud again before calling the low-level refund mock.

`MockStore` owns mutable in-memory customer, transaction, refund, and ticket data. Trusted customer records never enter graph responses. Tool traces redact email values and hold only safe result shapes.
