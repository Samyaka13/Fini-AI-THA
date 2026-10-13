import "dotenv/config";
import { PaylaneAgent } from "./agent/graph.js";

const message = process.argv.slice(2).join(" ");
if (!message || message === "scenarios") {
  console.log("Run `npm test` to execute all 12 evaluated scenarios. For a single turn: npm run scenarios -- \"your message\"");
} else {
  const agent = new PaylaneAgent();
  const result = await agent.respond(message);
  console.log(result.response);
  console.log(JSON.stringify({ verified: result.session.verified, tools: result.traces }, null, 2));
}
