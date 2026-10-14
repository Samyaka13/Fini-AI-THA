import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PaylaneAgent } from "./agent/graph.js";

const useColor = Boolean(output.isTTY && !process.env.NO_COLOR);
const paint = (code: number, value: string): string => useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
const brand = (value: string): string => paint(36, value);
const muted = (value: string): string => paint(90, value);
const success = (value: string): string => paint(32, value);
const divider = (): string => muted("─".repeat(58));

function printBanner(): void {
  console.log(`\n${brand("╭──────────────────────────────────────────────────────────╮")}`);
  console.log(`${brand("│")}  ${paint(1, "PAYLANE SUPPORT")} ${muted("• secure support demo")}                 ${brand("│")}`);
  console.log(`${brand("╰──────────────────────────────────────────────────────────╯")}`);
  console.log(`${muted("Type /help for commands. Your account details stay private.")}\n`);
}

function printResponse(response: string): void {
  console.log(`\n${success("Paylane")}`);
  console.log(`${divider()}\n${response}\n`);
}

const message = process.argv.slice(2).join(" ");
if (message === "scenarios") {
  console.log("Run `npm test` to execute all 12 evaluated scenarios.");
} else if (message) {
  const agent = new PaylaneAgent();
  const result = await agent.respond(message);
  printResponse(result.response);
} else {
  await startChat();
}

async function startChat(): Promise<void> {
  let agent = new PaylaneAgent();
  const terminal = createInterface({ input, output });
  printBanner();
  try {
    while (true) {
      const customerMessage = (await terminal.question(`${brand("You")} ${muted("›")} `)).trim();
      if (!customerMessage) continue;
      if (customerMessage === "/exit" || customerMessage === "/quit") break;
      if (customerMessage === "/help") {
        console.log(`\n${paint(1, "Commands")}`);
        console.log(`${muted("/reset")}  Start a new support session`);
        console.log(`${muted("/clear")}  Clear this terminal window`);
        console.log(`${muted("/exit")}   End the chat\n`);
        continue;
      }
      if (customerMessage === "/reset") {
        agent = new PaylaneAgent();
        console.log(`\n${success("✓ Started a new support session.")}\n`);
        continue;
      }
      if (customerMessage === "/clear") {
        console.clear();
        printBanner();
        continue;
      }
      const result = await agent.respond(customerMessage);
      printResponse(result.response);
    }
  } finally {
    terminal.close();
  }
}
