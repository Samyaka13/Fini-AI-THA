import { z } from "zod";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export type LlmRole = "user" | "assistant";
export interface LlmMessage { role: LlmRole; content: string; }
export interface LlmToolCall { id: string; name: string; arguments: Record<string, unknown>; }
export interface LlmCompletion { content: string; toolCalls: LlmToolCall[]; }
export interface LlmClient { complete(messages: LlmMessage[]): Promise<LlmCompletion>; }

const toolSchemas = [
  { type: "function", function: { name: "get_customer", description: "Request trusted account verification after the customer supplies their email. Never disclose account data.", parameters: { type: "object", properties: { email: { type: "string" } }, required: ["email"], additionalProperties: false } } },
  { type: "function", function: { name: "get_transaction", description: "Request a verified customer's owned transaction.", parameters: { type: "object", properties: { customer_id: { type: "string" }, txn_id: { type: "string" } }, required: ["customer_id", "txn_id"], additionalProperties: false } } },
  { type: "function", function: { name: "issue_refund", description: "Request a policy-gated refund. Success must be confirmed by the tool.", parameters: { type: "object", properties: { txn_id: { type: "string" }, amount: { type: "number" } }, required: ["txn_id", "amount"], additionalProperties: false } } },
  { type: "function", function: { name: "escalate_to_human", description: "Request a human support ticket. customer_id may be null for anonymous escalation.", parameters: { type: "object", properties: { customer_id: { type: ["string", "null"] }, summary: { type: "string" } }, required: ["customer_id", "summary"], additionalProperties: false } } },
] as const;

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) })).optional() }) })).min(1),
  error: z.object({ message: z.string() }).optional(),
});

/** OpenRouter Chat Completions client for google/gemini-3.8-flash. */
export class OpenRouterClient implements LlmClient {
  constructor(private readonly apiKey: string, private readonly fetcher: typeof fetch = fetch) {}

  static fromEnvironment(): OpenRouterClient | null {
    const apiKey = process.env.OPENROUTER_API_KEY;
    return apiKey ? new OpenRouterClient(apiKey) : null;
  }

  async complete(messages: LlmMessage[]): Promise<LlmCompletion> {
    const response = await this.fetcher("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/gemini-3.8-flash", messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages], tools: toolSchemas, tool_choice: "auto", temperature: 0, max_tokens: 300 }),
    });
    const payload: unknown = await response.json();
    const parsed = responseSchema.safeParse(payload);
    if (!response.ok || !parsed.success) {
      const detail = parsed.success ? parsed.data.error?.message : "invalid OpenRouter response";
      throw new Error(`OpenRouter request failed (${response.status}): ${detail ?? "unknown error"}`);
    }
    const message = parsed.data.choices[0]!.message;
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: safeJsonObject(call.function.arguments),
    }));
    return { content: message.content ?? "", toolCalls };
  }
}

function safeJsonObject(value: string): Record<string, unknown> {
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

/** Do not transmit email addresses or card digits to the third-party LLM. */
export function sanitizeForLlm(content: string): string {
  return content
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[account-email]")
    .replace(/(last\s*(?:four|4)|card)\D{0,12}\d{4}/gi, "$1 [card-last-four]");
}
