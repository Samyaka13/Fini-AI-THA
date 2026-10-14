# Paylane Support Agent — Customer Note

Hi Team,

The Paylane Support Agent automates three core workflows: customer account verification, transaction inquiries, and refund requests. It can also escalate cases to a human support specialist.

### How It Works

The agent uses four APIs:

- `get_customer` — Customer lookup and verification.
- `get_transaction` — Transaction details and refund status.
- `issue_refund` — Processing eligible refunds.
- `escalate_to_human` — Referring cases for specialist review.

The LLM interprets customer messages, while the application executes API calls and enforces your organization's policies. **Customer data stays within the application and is not sent to the LLM**, as verified in testing. This helps minimize data exposure while keeping transaction access and policy enforcement under application control.

### Policy and Security

The agent follows configured refund rules and cannot bypass them just because a customer requests an exception or attempts social engineering. Ineligible refunds, suspected fraud, and other restricted cases are handled according to policy, including escalation where required.

### Integration Requirements

To integrate the agent, we need customer and transaction data in agreed schemas, API documentation .

The agent's capabilities depend on the APIs your organization exposes. It cannot perform operations those APIs do not support.

The goal is to automate routine support, enforce policies consistently, protect customer data, and provide human assistance when needed.

Regards,  
Paylane Support Agent Team