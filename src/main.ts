import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PaylaneAgent } from "./agent/graph.js";

const message = process.argv.slice(2).join(" ");
if (message === "scenarios") {
  console.log("Run `npm test` to execute all 12 evaluated scenarios.");
} else if (message) {
  const agent = new PaylaneAgent();
  const result = await agent.respond(message);
  console.log(result.response);
} else {
  await startChat();
}

async function startChat(): Promise<void> {
  let agent = new PaylaneAgent();
  const terminal = createInterface({ input, output });
  console.log("Paylane Support Agent — type /help for commands, /exit to finish.");
  try {
    while (true) {
      const customerMessage = (await terminal.question("You: ")).trim();
      if (!customerMessage) continue;
      if (customerMessage === "/exit" || customerMessage === "/quit") break;
      if (customerMessage === "/help") {
        console.log("Commands: /reset starts a new support session; /exit ends the chat.");
        continue;
      }
      if (customerMessage === "/reset") {
        agent = new PaylaneAgent();
        console.log("Paylane: Started a new support session.");
        continue;
      }
      const result = await agent.respond(customerMessage);
      console.log(`Paylane: ${result.response}`);
    }
  } finally {
    terminal.close();
  }
}
