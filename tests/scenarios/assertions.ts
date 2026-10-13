import { expect } from "vitest";
import type { TurnResult } from "../../src/agent/graph.js";
import type { ScenarioCase } from "./cases.js";

export function assertScenario(scenario: ScenarioCase, turns: TurnResult[]): void {
  const final = turns.at(-1)!;
  const tools = turns.flatMap((turn) => turn.traces.map((trace) => trace.tool));
  for (const tool of scenario.requiredTools) expect(tools, `${scenario.id} requires ${tool}`).toContain(tool);
  for (const tool of scenario.forbiddenTools) expect(tools, `${scenario.id} must not call ${tool}`).not.toContain(tool);
  expect(final.session.verified, `${scenario.id} verification state`).toBe(scenario.verified);
  for (const phrase of scenario.finalIncludes) expect(final.response.toLowerCase()).toContain(phrase.toLowerCase());
  // Customer-facing text must not disclose stored card values or a raw email record.
  expect(final.response).not.toContain("4242");
  expect(final.response).not.toContain("9876");
  expect(final.response).not.toContain("alice@example.com");
}
