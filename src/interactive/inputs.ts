import fsp from "node:fs/promises";
import path from "node:path";
import { expandInputArgs } from "../commands/inputs.js";
import type { InputSelection } from "../workflows/types.js";
import { CANCEL, PromptDriver } from "./driver.js";

const GLOB_PREVIEW_LIMIT = 20;
const BROAD_MATCH_THRESHOLD = 1_000;
const KNOWN_EXTENSIONS = new Set([
  ".md", ".mdx", ".markdown", ".pdf", ".html", ".htm", ".docx",
  ".csv", ".json", ".jsonl", ".ndjson", ".txt", ".text", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go",
  ".rs", ".java",
]);

export interface CollectedInputs {
  inputs: InputSelection[];
  resolvedFiles: string[];
}

type InputMenuChoice =
  | "browse"
  | "input"
  | "cwd"
  | "review"
  | "done"
  | "back";

export async function collectInputs(
  prompt: PromptDriver,
  cwd: string = process.cwd(),
  initial?: CollectedInputs,
): Promise<CollectedInputs | null> {
  const state = new InputState(initial);

  while (true) {
    const choice = await prompt.select<InputMenuChoice>({
      message: state.size > 0
        ? `Add files · ${state.size} selected`
        : "Add files",
      options: [
        { value: "browse", label: "Browse", hint: "files and folders" },
        { value: "input", label: "Enter a path or glob", hint: "docs/ or docs/**/*.md" },
        { value: "cwd", label: "Add current directory", hint: "." },
        ...(state.size > 0
          ? [
              { value: "review" as const, label: "Selected files", hint: "review or remove" },
              { value: "done" as const, label: "Continue", hint: `${state.size} file${state.size === 1 ? "" : "s"}` },
            ]
          : []),
        { value: "back", label: "Cancel" },
      ],
    });

    if (choice === CANCEL || choice === "back") return null;
    if (choice === "done") return state.snapshot();
    if (choice === "review") {
      await reviewSelection(prompt, state, cwd);
      continue;
    }
    if (choice === "browse") {
      await browseDirectory(prompt, cwd, cwd, state);
      continue;
    }
    if (choice === "input") {
      await addPathOrGlob(prompt, cwd, state);
      continue;
    }
    if (choice === "cwd") {
      await addResolved(prompt, state, "directory", ".", cwd, cwd);
    }
  }
}

class InputState {
  private readonly files = new Set<string>();
  private readonly sources: InputSelection[] = [];

  constructor(initial?: CollectedInputs) {
    for (const file of initial?.resolvedFiles ?? []) this.files.add(path.resolve(file));
    this.sources.push(...(initial?.inputs ?? []));
  }

  get size(): number {
    return this.files.size;
  }

  add(selection: InputSelection, files: readonly string[]): number {
    const before = this.files.size;
    for (const file of files) this.files.add(path.resolve(file));
    if (this.files.size > before) this.sources.push(selection);
    return this.files.size - before;
  }

  has(file: string): boolean {
    return this.files.has(path.resolve(file));
  }

  remove(file: string): void {
    this.files.delete(path.resolve(file));
  }

  clear(): void {
    this.files.clear();
    this.sources.length = 0;
  }

  list(): string[] {
    return [...this.files].sort(comparePaths);
  }

  snapshot(): CollectedInputs {
    return { inputs: [...this.sources], resolvedFiles: this.list() };
  }
}

type BrowserChoice =
  | { kind: "up" }
  | { kind: "done" }
  | { kind: "toggle-hidden" }
  | { kind: "file"; path: string }
  | { kind: "directory"; path: string };

async function browseDirectory(
  prompt: PromptDriver,
  start: string,
  cwd: string,
  state: InputState,
): Promise<void> {
  let current = path.resolve(start);
  let showHidden = false;

  while (true) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    const visible = entries
      .filter((entry) => showHidden || !entry.name.startsWith("."))
      .filter((entry) => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const options: Array<{ value: BrowserChoice; label: string; hint?: string }> = [];
    if (path.dirname(current) !== current) {
      options.push({ value: { kind: "up" }, label: "../", hint: "go up" });
    }
    options.push(
      ...visible.map((entry) => {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) {
          return { value: { kind: "directory" as const, path: target }, label: `${entry.name}/`, hint: "folder" };
        }
        const selected = state.has(target);
        const known = KNOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
        return {
          value: { kind: "file" as const, path: target },
          label: selected ? `✓ ${entry.name}` : entry.name,
          hint: selected ? "selected" : known ? "supported" : "content will be detected",
        };
      }),
    );
    options.push(
      { value: { kind: "toggle-hidden" }, label: showHidden ? "Hide hidden entries" : "Show hidden entries" },
      { value: { kind: "done" }, label: "Finish browsing", hint: `${state.size} selected` },
    );

    const choice = await prompt.select<BrowserChoice>({
      message: relativeDisplay(current, cwd),
      options,
    });
    if (choice === CANCEL || choice.kind === "done") return;
    if (choice.kind === "up") {
      current = path.dirname(current);
      continue;
    }
    if (choice.kind === "toggle-hidden") {
      showHidden = !showHidden;
      continue;
    }
    if (choice.kind === "file") {
      if (state.has(choice.path)) state.remove(choice.path);
      else state.add({ kind: "file", label: relativeDisplay(choice.path, cwd) }, [choice.path]);
      continue;
    }
    await handleDirectory(prompt, choice.path, cwd, state);
  }
}

async function handleDirectory(
  prompt: PromptDriver,
  directory: string,
  cwd: string,
  state: InputState,
): Promise<void> {
  type DirectoryChoice = "recursive" | "browse" | "files" | "back";
  const choice = await prompt.select<DirectoryChoice>({
    message: `${relativeDisplay(directory, cwd)}/`,
    options: [
      { value: "recursive", label: "Add all files", hint: "includes subfolders" },
      { value: "browse", label: "Open folder" },
      { value: "files", label: "Choose files here", hint: "this folder only" },
      { value: "back", label: "Back" },
    ],
  });
  if (choice === CANCEL || choice === "back") return;
  if (choice === "recursive") {
    await addResolved(
      prompt,
      state,
      "directory",
      relativeDisplay(directory, cwd),
      directory,
      cwd,
    );
    return;
  }
  if (choice === "browse") {
    await browseDirectory(prompt, directory, cwd, state);
    return;
  }
  await selectImmediateFiles(prompt, directory, cwd, state);
}

async function selectImmediateFiles(
  prompt: PromptDriver,
  directory: string,
  cwd: string,
  state: InputState,
): Promise<void> {
  const entries = (await fsp.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length === 0) {
    prompt.note("This folder has no directly contained files.", "Nothing to select");
    return;
  }
  const choices = await prompt.multiSelect<string>({
    message: `Select files in ${relativeDisplay(directory, cwd)}`,
    options: entries.map((entry) => ({
      value: path.join(directory, entry.name),
      label: entry.name,
      hint: KNOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ? "supported"
        : "content will be detected",
    })),
    required: false,
  });
  if (choices === CANCEL) return;
  for (const file of choices) {
    state.add({ kind: "file", label: relativeDisplay(file, cwd) }, [file]);
  }
}

async function addPathOrGlob(prompt: PromptDriver, cwd: string, state: InputState): Promise<void> {
  const input = await prompt.text({
    message: "Path or glob",
    placeholder: "docs/ or docs/**/*.md",
    validate: (value) => (value ?? "").trim() ? undefined : "Enter a file, folder, or glob.",
  });
  if (input === CANCEL) return;
  const value = input.trim();
  const kind: InputSelection["kind"] = /[*?\[\]{}]/.test(value) ? "glob" : "path";
  await addResolved(prompt, state, kind, value, value, cwd);
}

async function addResolved(
  prompt: PromptDriver,
  state: InputState,
  kind: InputSelection["kind"],
  label: string,
  input: string,
  cwd: string,
): Promise<void> {
  let matches: string[];
  try {
    matches = await expandInputArgs([input], cwd);
  } catch (err) {
    prompt.note((err as Error).message, "Input could not be added");
    return;
  }

  prompt.note(renderMatchPreview(matches, cwd), `${matches.length.toLocaleString()} file${matches.length === 1 ? "" : "s"}`);
  if (matches.length >= BROAD_MATCH_THRESHOLD) {
    const broad = await prompt.confirm({
      message: `Add all ${matches.length.toLocaleString()} files?`,
      initialValue: false,
    });
    if (broad === CANCEL || !broad) return;
  } else {
    const confirmed = await prompt.confirm({
      message: `Add ${matches.length.toLocaleString()} file${matches.length === 1 ? "" : "s"}?`,
      initialValue: true,
    });
    if (confirmed === CANCEL || !confirmed) return;
  }

  state.add({ kind, label }, matches);
}

async function reviewSelection(
  prompt: PromptDriver,
  state: InputState,
  cwd: string,
): Promise<void> {
  while (state.size > 0) {
    const files = state.list();
    prompt.note(renderMatchPreview(files, cwd, 40), `${files.length} selected file${files.length === 1 ? "" : "s"}`);
    type ReviewChoice = "remove" | "clear" | "back";
    const choice = await prompt.select<ReviewChoice>({
      message: "Selected files",
      options: [
        { value: "remove", label: "Remove a file" },
        { value: "clear", label: "Clear selection" },
        { value: "back", label: "Back" },
      ],
    });
    if (choice === CANCEL || choice === "back") return;
    if (choice === "clear") {
      state.clear();
      return;
    }
    const remove = await prompt.select<string>({
      message: "Remove which file?",
      options: files.map((file) => ({ value: file, label: relativeDisplay(file, cwd) })),
    });
    if (remove !== CANCEL) state.remove(remove);
  }
}

function renderMatchPreview(files: readonly string[], cwd: string, limit = GLOB_PREVIEW_LIMIT): string {
  const shown = files.slice(0, limit).map((file) => `  ${relativeDisplay(file, cwd)}`);
  if (files.length > limit) shown.push(`  …and ${(files.length - limit).toLocaleString()} more`);
  return shown.join("\n");
}

function relativeDisplay(target: string, cwd: string): string {
  const relative = path.relative(cwd, target);
  return relative && !relative.startsWith("..") ? relative : target;
}

function comparePaths(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export const _internal = {
  BROAD_MATCH_THRESHOLD,
  KNOWN_EXTENSIONS,
  renderMatchPreview,
};
