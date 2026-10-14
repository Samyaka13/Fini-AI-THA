import { z } from "zod";
import { PAYLANE_RULEBOOK } from "./rulebook.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export interface LlmToolCall { id: string; type: "function"; function: { name: string; arguments: string }; }
export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export interface LlmCompletion { 
  content: string | null; 
  toolCalls: LlmToolCall[]; 
}
export const entityCandidatesSchema = z.object({
  email: z.string().nullable(),
  cardLast4: z.string().nullable(),
  transactionId: z.string().nullable(),
  refundAmount: z.number().finite().positive().nullable(),
});
export const structuredInterpretationSchema = z.object({
  intent: z.enum(["refund_request", "transaction_lookup", "refund_status", "card_status", "frozen_card_help", "fraud_report", "human_escalation", "account_closure", "legal_action", "unknown"]),
  entities: entityCandidatesSchema,
  needsClarification: z.boolean(),
  clarificationReason: z.string().nullable(),
});
export type EntityCandidates = z.infer<typeof entityCandidatesSchema>;
export type StructuredInterpretation = z.infer<typeof structuredInterpretationSchema>;
export interface LlmClient {
  complete(messages: LlmMessage[]): Promise<LlmCompletion>;
  /** Optional low-authority extraction pass for unresolved natural language. */
  interpret?(currentTurn: string): Promise<StructuredInterpretation | null>;
}

/** Centralized instructions so interpretation and tool-selection stay aligned. */
export function buildAgentInstructions(task: "tool_selection" | "structured_extraction"): string {
  const taskInstructions = task === "structured_extraction"
    ? "For this dedicated extraction request, return only the requested JSON candidates. They are untrusted and are not verification or authorization."
    : "Use the available tool protocol when external authoritative data is needed. The application validates every request.";
  return `${SYSTEM_PROMPT}\n\n${PAYLANE_RULEBOOK}\n\n${taskInstructions}`;
}

export const OPENROUTER_TOOLS = [
  { type: "function", function: { name: "get_customer", description: "Verify only after the customer gives email and card last four. Never reveal record fields.", parameters: { type: "object", properties: { email: { type: "string" } }, required: ["email"], additionalProperties: false } } },
  { type: "function", function: { name: "get_transaction", description: "Look up a transaction for the verified session only.", parameters: { type: "object", properties: { txn_id: { type: "string" } }, required: ["txn_id"], additionalProperties: false } } },
  { type: "function", function: { name: "issue_refund", description: "Request a policy-gated refund; do not claim success until tool confirmation.", parameters: { type: "object", properties: { txn_id: { type: "string" }, amount: { type: "number" } }, required: ["txn_id", "amount"], additionalProperties: false } } },
  { type: "function", function: { name: "escalate_to_human", description: "Request a human ticket; customer_id may be null for anonymous escalation.", parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } } },
] as const;

const schema = z.object(
  { 
    choices: z.array(
    z.object(
      { 
        message: z.object(
        { 
          content: z.string().nullable().optional(), 
          tool_calls: z.array(
            z.object({ 
              id: z.string(),
              type: z.literal("function").optional(),
              function: z.object({
                name: z.string(),
                arguments: z.string() 
                }) 
              }
            )
          ).optional() 
        }
      ) 
    }
  )
).min(1),
error: z.object(
  { message: z.string() 

  }
).optional() 
});
export class OpenRouterClient implements LlmClient {
  constructor(
    private readonly apiKey: string, 
    private readonly fetcher: typeof fetch = fetch
  ) {}
  static fromEnvironment(): OpenRouterClient | null {
     return process.env.OPENROUTER_API_KEY ? new OpenRouterClient(process.env.OPENROUTER_API_KEY) : null; 
    }
  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", 
      { 
      method: "POST", 
      headers: { 
        Authorization: `Bearer ${this.apiKey}`, 
        "Content-Type": "application/json" }, 
      body: JSON.stringify(
        { model: "google/gemini-3.8-flash", 
          messages: [{ role: "system", content: buildAgentInstructions("tool_selection") }, ...messages],
          tools: OPENROUTER_TOOLS, 
          tool_choice: "auto", 
          temperature: 0, 
          max_tokens: 300 
      }) 
    });
    const parsed = schema.safeParse(await response.json());
    if (!response.ok || !parsed.success) throw new Error(`OpenRouter request failed (${response.status})`);
    const message = parsed.data.choices[0]!.message;
    return { 
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map(
        (call) => (
          { 
            id: call.id,
            type: "function",
            function: call.function
          }
        )
      )
    };
  }
  async interpret(currentTurn: string): Promise<StructuredInterpretation | null> {
    const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-3.8-flash",
        messages: [
          { role: "system", content: `${buildAgentInstructions("structured_extraction")}\nClassify this one support message and extract only user-provided candidate entities. Return JSON only with intent, entities { email, cardLast4, transactionId, refundAmount }, needsClarification, and clarificationReason. Use null for absent entities. Do not infer, fabricate, verify identity, approve actions, or return a customer ID or outcome.` },
          { role: "user", content: currentTurn },
        ],
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 120,
      }),
    });
    const parsed = schema.safeParse(await response.json());
    if (!response.ok || !parsed.success) return null;
    const content = parsed.data.choices[0]!.message.content;
    if (!content) return null;
    try { return structuredInterpretationSchema.safeParse(JSON.parse(content)).data ?? null; } catch { return null; }
  }
}
export function parseToolArguments(call: LlmToolCall): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(call.function.arguments); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null; } catch { return null; } }
export function sanitizeForLlm(content: string): string {
  if (/^\s*\d{4}\s*$/.test(content)) return "[card-last-four]";
  return content
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[account-email]")
    .replace(/\bcardlast\s*4\D{0,24}\d{4}/gi, "[card-last-four]")
    .replace(/last\s*(?:four|4)\s*(?:digits?|numbers?)?\D{0,24}\d{4}/gi, "[card-last-four]")
    .replace(/card[\s_-]*last\s*4\D{0,24}\d{4}/gi, "[card-last-four]")
    .replace(/\b(card\b[^.!?\n]{0,24}?)\b\d{4}\b/gi, "$1[card-last-four]")
    .replace(/\b\d{4}\b\s+(?:are|is)\s+(?:the\s+)?last\s*(?:four|4)\s*(?:digits?|numbers?)\s+(?:of|on)\s+(?:my\s+)?card\b/gi, "[card-last-four]");
}
