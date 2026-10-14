# Conversation 11: Partial Refund Request

**Scenario:** The customer requests $40 back from a $45 transaction. The latest policy allows automatic refunds only for the full transaction amount when the original charge is $75 or less.

## Conversation

**Customer:** I want a refund  
**Paylane:** To help with account or transaction requests, please provide your account email.  
**Customer:** farah@example.com  
**Paylane:** To help with account or transaction requests, please provide the last four digits of your card.  
**Customer:** 9876  
**Paylane:** Please share the transaction ID so I can look into the refund.  
**Customer:** txn_farah_45  
**Paylane:** What refund amount are you requesting?  
**Customer:** $40  
**Paylane:** Automatic refunds must be for the full original transaction amount. I’ve sent this to a specialist. (ticket tkt_0001).

## Observed Behavior

The customer was verified and the settled $45 transaction was retrieved. Because the customer requested a partial refund of $40, the agent escalated the request and did not call `issue_refund`.

**Evaluation: PASS** — Partial refunds require human review under the latest clarification.

## Final Graph State

```json
{
  "response": "Automatic refunds must be for the full original transaction amount. I’ve sent this to a specialist. (ticket tkt_0001).",
  "session": {
    "verified": true,
    "customerId": "[redacted]",
    "suppliedEmail": "[redacted]",
    "suppliedCardLast4": "[redacted]",
    "pendingRefund": null,
    "loadedTransactionId": null,
    "hasLastEscalation": true
  },
  "traces": [
    {
      "tool": "escalate_to_human",
      "origin": "policy",
      "args": {
        "customer_id": "[redacted]",
        "summary": "partial refund request; full refund required"
      },
      "result": {
        "ticket_id": "tkt_0001"
      }
    }
  ],
  "llmToolCalls": [],
  "llmError": null
}
```
