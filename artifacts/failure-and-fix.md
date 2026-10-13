# Failure and fix evidence

## Fraud amount extraction regression

The first post-refactor scenario run failed scenario 10. The trace showed an `escalate_to_human` call, but the final response lacked “immediate review” for “I did not authorize a $700 transaction.” The fraud classifier recognized the report, while `extractFraudAmount` omitted `did not authorize`; the amount was unknown and the immediate flag was false.

Fix: added `did not authorize` to the fraud-amount clause matcher and a regression test covering a $40 refund request alongside a $700 fraud report.

Rerun: `npm run build && npm test` passed: 6 test files and 17 tests, including all 12 evaluated scenarios. The scenario trace now contains the immediate escalation outcome.

## Provider boundary

No live OpenRouter request was executed during evaluation. Unit tests use a mocked provider to verify protocol formatting, tool-call IDs, malformed-message handling, and PII redaction; scenarios run offline through the actual LangGraph workflow.
