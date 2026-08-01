import { loadConfig } from "../config/index.js";
import { isAutoEmbedError } from "../errors.js";
import { pc } from "../log.js";
import {
  runConfigurationMenu,
} from "./configuration.js";
import { CANCEL, ClackPromptDriver, PromptDriver } from "./driver.js";
import { runNewWorkflow } from "./workflow.js";
import type { WorkflowResult } from "../workflows/types.js";

export interface TerminalState {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  ci?: string;
}

export function shouldStartInteractive(
  args: readonly string[],
  terminal: TerminalState = {
    stdinIsTTY: process.stdin.isTTY,
    stdoutIsTTY: process.stdout.isTTY,
    ci: process.env.CI,
  },
): boolean {
  return args.length === 0 && Boolean(terminal.stdinIsTTY && terminal.stdoutIsTTY && !terminal.ci);
}

export async function runInteractiveApp(
  prompt: PromptDriver = new ClackPromptDriver(),
): Promise<void> {
  prompt.intro(pc.bold("auto-embed"));

  while (true) {
    type HomeChoice = WorkflowResult | "settings" | "exit";
    const cfg = await loadConfig();
    const provider = cfg.defaults?.provider ?? "openai";
    const db = cfg.defaults?.db ?? "chroma";
    const choice = await prompt.select<HomeChoice>({
      message: "Select an action",
      options: [
        { value: "embed", label: "Embed files", hint: "add or update vectors" },
        { value: "preview", label: "Preview", hint: "check chunks and cost; write nothing" },
        { value: "chunks", label: "Inspect chunks", hint: "write readable chunk text" },
        { value: "plan", label: "Create a plan", hint: "save reusable chunk settings" },
        { value: "embed-export", label: "Export vectors", hint: "embed and write JSONL" },
        { value: "settings", label: "Settings", hint: `${provider} · ${db}` },
        { value: "exit", label: "Exit" },
      ],
    });

    if (choice === CANCEL || choice === "exit") {
      prompt.outro("Goodbye.");
      return;
    }

    try {
      if (choice === "settings") {
        await runConfigurationMenu(prompt);
      } else {
        await runNewWorkflow(prompt, process.cwd(), choice);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = isAutoEmbedError(err) ? err.hint : undefined;
      prompt.note(`${message}${hint ? `\n\nhint: ${hint}` : ""}`, "Could not complete that action");
    }
  }
}
