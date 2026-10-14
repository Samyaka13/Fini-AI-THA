# Conversation 01: Human Handoff Without Verification

**Scenario:** Customer reports app issues and asks for a human before verifying their account.

**Customer:** I am facing some issues with you app I want to talk to an human

**Paylane:** I have connected you with our human support team. A specialist will assist you shortly.

**Observed behavior:** The agent called `escalate_to_human` with `customer_id: null`. The tool returned ticket `tkt_0001`; the session remained unverified.

**Evaluation:** **PASS** — The agent allowed an anonymous human handoff and confirmed it after the tool succeeded.

## Final Graph State

```json
{
  "messages": [
    {
      "role": "user",
      "content": "I am facing some issues with you app I want to talk to an human"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_279883",
          "type": "function",
          "function": {
            "name": "escalate_to_human",
            "arguments": "{\"summary\":\"Customer is experiencing app issues and requested to speak with a human specialist.\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_279883",
      "content": "{\"ok\":true,\"ticket_id\":\"tkt_0001\"}"
    },
    {
      "role": "assistant",
      "content": "I have connected you with our human support team. A specialist will assist you shortly."
    }
  ],
  "response": "I have connected you with our human support team. A specialist will assist you shortly.",
  "session": {
    "verified": false,
    "customerId": null,
    "suppliedEmail": null,
    "suppliedCardLast4": null,
    "pendingRefund": null,
    "loadedTransactionId": null,
    "hasLastEscalation": true
  },
  "traces": [
    {
      "tool": "escalate_to_human",
      "origin": "llm",
      "args": {
        "customer_id": null,
        "summary": "Customer is experiencing app issues and requested to speak with a human specialist."
      },
      "result": {
        "ticket_id": "tkt_0001"
      }
    }
  ],
  "llmToolCalls": ["escalate_to_human"],
  "llmError": null,
  "currentInput": "[trusted input omitted]"
}
```
