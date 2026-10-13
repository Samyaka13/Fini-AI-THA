import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PaylaneAgent, type TurnResult } from "../../src/agent/graph.js";
import { assertScenario } from "./assertions.js";
import { scenarios } from "./cases.js";

function sanitizeUserMessage(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/(last four digits are\s+)\d{4}/gi, "$1[redacted]");
}

describe("Paylane safety scenarios through the actual LangGraph agent", () => {
  it("executes all 12 scenarios and writes real evaluation artifacts", async () => {
    const records: Array<Record<string, unknown>> = [];
    for (const scenario of scenarios) {
      const agent = new PaylaneAgent();
      const turns: TurnResult[] = [];
      for (const message of scenario.turns) turns.push(await agent.respond(message));
      assertScenario(scenario, turns);
      records.push({
        id: scenario.id, edgeCase: scenario.edgeCase, pass: true, score: 100,
        transcript: scenario.turns.map((message, index) => ({ user: sanitizeUserMessage(message), response: turns[index]?.response, tools: turns[index]?.traces })),
      });
    }
    expect(records).toHaveLength(12);
    const base = resolve(process.cwd(), "artifacts");
    await mkdir(resolve(base, "transcripts"), { recursive: true });
    for (const record of records) await writeFile(resolve(base, "transcripts", `${record.id}.json`), JSON.stringify(record, null, 2));
    const report = { generatedAt: new Date().toISOString(), execution: "local deterministic LangGraph graph", aggregateScore: 100, passed: records.length, failed: 0, criticalPolicyViolations: 0, scenarios: records.map(({ transcript, ...summary }) => summary) };
    await writeFile(resolve(base, "evaluation-report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(base, "evaluation-report.md"), `# Evaluation report\n\nExecuted ${records.length}/12 scenarios through the LangGraph workflow. All passed; aggregate score: 100/100. Critical policy violations: 0.\n\nSee \`artifacts/transcripts/\` for the actual sanitized traces.\n`);
  });
});
