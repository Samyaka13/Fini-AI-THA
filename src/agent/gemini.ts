import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

/**
 * Gemini/LangChain integration point for a deployed conversational layer.
 * These are declarations for model tool-calling, deliberately not raw store
 * functions: sensitive tools must be executed only through SafeToolExecutor.
 */
export function createGeminiToolCallingModel(apiKey = process.env.GOOGLE_API_KEY) {
  if (!apiKey) return null;
  const model = new ChatGoogleGenerativeAI({
    apiKey,
    model: process.env.GEMINI_MODEL ?? "gemini-2.0-flash",
    temperature: 0,
  });
  const tools = [
    tool(async () => ({ instruction: "Verification is performed by the trusted application layer. Do not expose customer records." }), {
      name: "get_customer", description: "Request account lookup for trusted verification only; never reveal stored account details.", schema: z.object({ email: z.string().email() }),
    }),
    tool(async () => ({ instruction: "Transaction lookup is performed only for a verified owning session." }), {
      name: "get_transaction", description: "Request an owned transaction lookup after verified account context exists.", schema: z.object({ customer_id: z.string(), txn_id: z.string() }),
    }),
    tool(async () => ({ instruction: "Refund execution is policy-gated by the trusted application layer." }), {
      name: "issue_refund", description: "Request a policy-gated refund; never assume this succeeds.", schema: z.object({ txn_id: z.string(), amount: z.number().positive() }),
    }),
    tool(async () => ({ instruction: "Escalation is created by the trusted application layer." }), {
      name: "escalate_to_human", description: "Request a human ticket, including anonymous escalation with null customer_id.", schema: z.object({ customer_id: z.string().nullable(), summary: z.string() }),
    }),
  ];
  return { systemPrompt: SYSTEM_PROMPT, model: model.bindTools(tools), tools };
}
