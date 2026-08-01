import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInteractiveApp, shouldStartInteractive } from "../src/interactive/app.js";
import {
  CANCEL,
  Cancel,
  PromptDriver,
  SelectQuestion,
  TextQuestion,
} from "../src/interactive/driver.js";
import { collectInputs } from "../src/interactive/inputs.js";
import {
  equivalentCommand,
  runNewWorkflow,
} from "../src/interactive/workflow.js";
import { inspectWorkflowRequirements } from "../src/workflows/requirements.js";
import type { WorkflowDraft } from "../src/workflows/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fsp.rm(directory, { recursive: true, force: true })
  ));
});

describe("interactive entry routing", () => {
  it("starts only for a bare invocation attached to input and output TTYs", () => {
    expect(shouldStartInteractive([], { stdinIsTTY: true, stdoutIsTTY: true })).toBe(true);
    expect(shouldStartInteractive(["--help"], { stdinIsTTY: true, stdoutIsTTY: true })).toBe(false);
    expect(shouldStartInteractive([], { stdinIsTTY: false, stdoutIsTTY: true })).toBe(false);
    expect(shouldStartInteractive([], { stdinIsTTY: true, stdoutIsTTY: false })).toBe(false);
    expect(shouldStartInteractive([], { stdinIsTTY: true, stdoutIsTTY: true, ci: "1" })).toBe(false);
  });

  it("puts primary tasks directly on the home screen", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = await fixtureDirectory();
    try {
      const prompt = new ScriptedPrompt(["exit"]);
      await runInteractiveApp(prompt);
      expect(prompt.selectQuestions[0]?.message).toBe("Select an action");
      expect(prompt.selectQuestions[0]?.options.map((option) => option.label)).toEqual([
        "Embed files",
        "Preview",
        "Inspect chunks",
        "Create a plan",
        "Export vectors",
        "Settings",
        "Exit",
      ]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

describe("interactive input collection", () => {
  it("expands and previews a glob before accepting its files", async () => {
    const cwd = await fixtureDirectory();
    const prompt = new ScriptedPrompt(["input", "**/*.md", true, "done"]);
    const result = await collectInputs(prompt, cwd);

    expect(result?.resolvedFiles.map((file) => path.relative(cwd, file))).toEqual([
      "docs/a.md",
      "docs/nested/b.md",
    ]);
    expect(prompt.notes.some((note) => note.includes("2 files"))).toBe(true);
  });

  it("asks how to handle a selected folder and can include it recursively", async () => {
    const cwd = await fixtureDirectory();
    const docs = path.join(cwd, "docs");
    const prompt = new ScriptedPrompt([
      "browse",
      { kind: "directory", path: docs },
      "recursive",
      true,
      { kind: "done" },
      "done",
    ]);
    const result = await collectInputs(prompt, cwd);

    expect(result?.resolvedFiles.map((file) => path.relative(cwd, file))).toEqual([
      "docs/a.md",
      "docs/nested/b.md",
    ]);
    const browser = prompt.selectQuestions.find((question) =>
      question.options.some((option) => option.label === "docs/")
    );
    expect(browser?.options.some((option) => option.label.startsWith("○ "))).toBe(false);
    const folderPrompt = prompt.selectQuestions.find((question) => question.message === "docs/");
    expect(folderPrompt?.options.map((option) => option.label)).toEqual([
      "Add all files",
      "Open folder",
      "Choose files here",
      "Back",
    ]);
  });
});

describe("workflow requirements", () => {
  it("does not require credentials for chunk inspection", () => {
    expect(inspectWorkflowRequirements({
      result: "chunks",
      planMode: "heuristic",
      provider: "openai",
      db: "pgvector",
    }, {})).toEqual([]);
  });

  it("returns structured provider and database requirements for embedding", () => {
    expect(inspectWorkflowRequirements({
      result: "embed",
      planMode: "heuristic",
      provider: "openai",
      db: "pgvector",
    }, {}, {})).toEqual([
      { kind: "provider-key", provider: "openai" },
      { kind: "database-url", db: "pgvector" },
    ]);
  });

  it("accepts stored OpenAI or Google credentials for LLM planning", () => {
    expect(inspectWorkflowRequirements({
      result: "plan",
      planMode: "llm",
      provider: "openai",
      db: "chroma",
    }, { apiKeys: { openai: "sk-stored-example" } }, {})).toEqual([]);
  });

  it("respects an explicitly selected planner provider", () => {
    expect(inspectWorkflowRequirements({
      result: "plan",
      planMode: "llm",
      provider: "openai",
      db: "chroma",
    }, { apiKeys: { openai: "sk-stored-example" } }, {
      AUTO_EMBED_PLAN_PROVIDER: "anthropic",
    })).toEqual([{ kind: "planner-key" }]);
  });
});

describe("interactive workflow", () => {
  it("runs a complete result-first dry-run workflow and returns home", async () => {
    const cwd = await fixtureDirectory();
    const prompt = new ScriptedPrompt([
      "input",
      "docs/a.md",
      true,
      "done",
      "run",
    ]);

    await expect(runNewWorkflow(prompt, cwd, "preview")).resolves.toBeUndefined();
    expect(prompt.notes.some((note) => note.includes("Preview 1 file"))).toBe(true);
  });

  it("renders a safely quoted reproducible command without credentials", () => {
    const draft: WorkflowDraft = {
      result: "embed-export",
      inputs: [{ kind: "glob", label: "docs/**/*.md" }],
      resolvedFiles: ["/repo/docs/a.md"],
      provider: "openai",
      model: "text-embedding-3-small",
      db: "pinecone",
      collection: "team handbook",
      planMode: "heuristic",
      metadata: { owner: "docs team" },
      output: "build/vectors.jsonl",
      force: false,
      local: false,
    };

    const command = equivalentCommand(draft);
    expect(command).toContain("/repo/docs/a.md");
    expect(command).toContain("--provider openai");
    expect(command).toContain("--out-vectors build/vectors.jsonl");
    expect(command).toContain("'team handbook'");
    expect(command).not.toMatch(/api.?key|secret|sk-/i);
  });
});

class ScriptedPrompt implements PromptDriver {
  readonly notes: string[] = [];
  readonly selectQuestions: SelectQuestion<unknown>[] = [];
  private readonly answers: unknown[];

  constructor(answers: unknown[]) {
    this.answers = [...answers];
  }

  intro(): void {}
  outro(): void {}

  async select<T>(question: SelectQuestion<T>): Promise<T | Cancel> {
    this.selectQuestions.push(question as SelectQuestion<unknown>);
    return this.next<T>();
  }

  async multiSelect<T>(_question: SelectQuestion<T>): Promise<T[] | Cancel> {
    return this.next<T[]>();
  }

  async text(_question: TextQuestion): Promise<string | Cancel> {
    return this.next<string>();
  }

  async password(_question: Omit<TextQuestion, "initialValue">): Promise<string | Cancel> {
    return this.next<string>();
  }

  async confirm(): Promise<boolean | Cancel> {
    return this.next<boolean>();
  }

  note(message: string, title?: string): void {
    this.notes.push(`${title ?? ""}\n${message}`);
  }

  private next<T>(): T | Cancel {
    if (this.answers.length === 0) return CANCEL;
    return this.answers.shift() as T;
  }
}

async function fixtureDirectory(): Promise<string> {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-interactive-"));
  temporaryDirectories.push(cwd);
  await fsp.mkdir(path.join(cwd, "docs", "nested"), { recursive: true });
  await fsp.mkdir(path.join(cwd, "node_modules", "ignored"), { recursive: true });
  await fsp.writeFile(path.join(cwd, "docs", "a.md"), "# Alpha\n\nFirst document.\n");
  await fsp.writeFile(path.join(cwd, "docs", "nested", "b.md"), "# Beta\n\nSecond document.\n");
  await fsp.writeFile(path.join(cwd, "node_modules", "ignored", "c.md"), "ignored\n");
  return cwd;
}
