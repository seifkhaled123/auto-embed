import { DEFAULT_SEPARATORS, recursiveSplit, TokenCounter } from "./recursive.js";

interface MarkdownSplitOptions {
  chunkSize: number;
  overlap: number;
  countTokens: TokenCounter;
  headerPath?: string[];
}

interface MarkdownNode {
  type: string;
  lang?: string | null;
  meta?: string | null;
  value?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: MarkdownNode[];
}

interface CodeBlock {
  start: number;
  end: number;
  language: string;
  info: string;
  content: string;
  parts?: Array<Pick<CodeBlock, "language" | "info" | "content">>;
}

interface MarkdownUnit {
  text: string;
  kind: "prose" | "code" | "table";
  standalone: boolean;
}

interface TableBlock {
  start: number;
  end: number;
  header: string;
  delimiter: string;
  rows: string[];
}

interface JsonFragment {
  path: string;
  value: unknown;
}

/**
 * Split a header-keyed Markdown section while retaining the section breadcrumb
 * and respecting Markdown code nodes. Large snippets are re-fenced into
 * self-contained excerpts; valid JSON is divided into valid JSON values with
 * a JSON-path label rather than cut at arbitrary lines.
 */
export async function splitMarkdownSection(
  text: string,
  opts: MarkdownSplitOptions,
): Promise<string[]> {
  const context = renderHeaderContext(opts.headerPath ?? []);
  const body = trimBlankLines(stripLeadingHeading(text));
  if (!body) return context ? [context] : text.trim() ? [text.trim()] : [];

  const contextSeparator = context ? "\n\n" : "";
  const contextTokens = opts.countTokens(context + contextSeparator);
  const bodyBudget = Math.max(1, opts.chunkSize - contextTokens);
  const units = await markdownUnits(body, bodyBudget, opts.countTokens);
  const bodies = packMarkdownUnits(units, bodyBudget, opts.overlap, opts.countTokens);

  return bodies.map((chunk) => context ? `${context}${contextSeparator}${chunk}` : chunk);
}

function renderHeaderContext(headerPath: string[]): string {
  return headerPath
    .filter((header): header is string => typeof header === "string" && header.trim() !== "")
    .filter((header, index, all) => index === 0 || header.trim() !== all[index - 1]!.trim())
    .map((header, index) => `${"#".repeat(Math.min(index + 1, 6))} ${header.trim()}`)
    .join("\n\n");
}

function stripLeadingHeading(text: string): string {
  return text.replace(/^#{1,3}[\t ]+[^\n]*(?:\r?\n|$)/, "");
}

function trimBlankLines(text: string): string {
  return text
    .replace(/^(?:[\t ]*\r?\n)+/, "")
    .replace(/(?:\r?\n[\t ]*)+$/, "");
}

async function markdownUnits(
  text: string,
  budget: number,
  countTokens: TokenCounter,
): Promise<MarkdownUnit[]> {
  const blocks = await markdownCodeBlocks(text);
  const units: MarkdownUnit[] = [];
  let cursor = 0;

  for (const block of blocks) {
    units.push(...proseUnits(text.slice(cursor, block.start), budget, countTokens));
    const codeParts = block.parts ?? [block];
    for (const part of codeParts) {
      units.push(...codeUnits({ ...part, start: block.start, end: block.end }, budget, countTokens));
    }
    cursor = block.end;
  }
  units.push(...proseUnits(text.slice(cursor), budget, countTokens));
  return units;
}

function proseUnits(text: string, budget: number, countTokens: TokenCounter): MarkdownUnit[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const tables = markdownTableBlocks(trimmed);
  if (tables.length > 0) {
    const units: MarkdownUnit[] = [];
    let cursor = 0;
    for (const table of tables) {
      units.push(...plainProseUnits(trimmed.slice(cursor, table.start), budget, countTokens));
      units.push(...tableUnits(table, budget, countTokens));
      cursor = table.end;
    }
    units.push(...plainProseUnits(trimmed.slice(cursor), budget, countTokens));
    return units;
  }
  return plainProseUnits(trimmed, budget, countTokens);
}

function plainProseUnits(
  text: string,
  budget: number,
  countTokens: TokenCounter,
): MarkdownUnit[] {
  const trimmed = normalizeMdxContainers(text).trim();
  if (!trimmed) return [];
  const inline = protectInlineCode(trimmed);
  const pieces = countTokens(trimmed) <= budget
    ? [inline.text]
    : recursiveSplit(inline.text, {
      separators: DEFAULT_SEPARATORS.markdown!,
      chunkSize: budget,
      overlap: 0,
      countTokens: (candidate) => countTokens(inline.restore(candidate)),
    });
  return pieces.map((piece) => ({
    text: inline.restore(piece),
    kind: "prose",
    standalone: false,
  }));
}

function normalizeMdxContainers(text: string): string {
  const documentationContainers = new Set([
    "Tabs",
    "Tab",
    "Steps",
    "Step",
    "Frame",
    "CodeGroup",
    "Expandable",
    "Accordion",
    "ComponentProps",
    "Info",
    "Warning",
    "Note",
    "Tip",
    "Caution",
    "Danger",
  ]);
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^[\t ]*#{1,6}[\t ]*$/.test(line)) return "";
      const closing = /^[\t ]*<\/([A-Z][A-Za-z0-9.]*)>[\t ]*$/.exec(line);
      if (closing) return documentationContainers.has(closing[1]!) ? "" : line;

      const opening = /^[\t ]*<([A-Z][A-Za-z0-9.]*)([^>]*)>[\t ]*$/.exec(line);
      if (!opening || /\/\s*>[\t ]*$/.test(line)) return line;
      const [, component, attributes] = opening;
      if (!documentationContainers.has(component!)) return line;
      const title = mdxStringAttribute(attributes!, "title");
      const componentName = mdxStringAttribute(attributes!, "componentName");

      if (
        component === "Tab" ||
        component === "Step" ||
        component === "Expandable" ||
        component === "Accordion"
      ) {
        return title ? `#### ${title}` : "";
      }
      if (component === "ComponentProps") {
        return componentName
          ? `**Component properties for \`${componentName}\`:**`
          : "**Component properties:**";
      }
      if (["Info", "Warning", "Note", "Tip", "Caution", "Danger"].includes(component!)) {
        return `**${component}:**`;
      }
      return "";
    })
    .join("\n");
}

function mdxStringAttribute(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return match?.[1] ?? match?.[2] ?? null;
}

function markdownTableBlocks(text: string): TableBlock[] {
  const lines = [...text.matchAll(/.*(?:\r?\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => ({
      start: match.index!,
      end: match.index! + match[0].length,
      text: match[0].replace(/\r?\n$/, ""),
    }));
  const blocks: TableBlock[] = [];

  for (let index = 1; index < lines.length; index++) {
    const header = lines[index - 1]!;
    const delimiter = lines[index]!;
    const headerCells = tableCells(header.text);
    const delimiterCells = tableCells(delimiter.text);
    if (
      headerCells.length === 0 ||
      headerCells.length !== delimiterCells.length ||
      !delimiterCells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
    ) {
      continue;
    }

    const rows: string[] = [];
    let end = delimiter.end;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const row = lines[cursor]!;
      if (tableCells(row.text).length !== headerCells.length) break;
      rows.push(row.text);
      end = row.end;
      cursor++;
    }
    blocks.push({
      start: header.start,
      end,
      header: renderTableCells(headerCells),
      delimiter: renderTableCells(delimiterCells.map(normalizeTableDelimiter)),
      rows: rows.map((row) => renderTableCells(tableCells(row))),
    });
    index = cursor - 1;
  }
  return blocks;
}

function renderTableCells(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function normalizeTableDelimiter(cell: string): string {
  const value = cell.trim();
  return `${value.startsWith(":") ? ":" : ""}---${value.endsWith(":") ? ":" : ""}`;
}

function tableCells(row: string): string[] {
  let value = row.trim();
  if (!value.includes("|")) return [];
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "|" && (index === 0 || value[index - 1] !== "\\")) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableUnits(
  table: TableBlock,
  budget: number,
  countTokens: TokenCounter,
): MarkdownUnit[] {
  const prefix = `${table.header}\n${table.delimiter}`;
  const units: MarkdownUnit[] = [];
  let rows: string[] = [];
  const separatorTokens = countTokens("\n");
  const prefixTokens = countTokens(prefix);
  let estimatedTokens = prefixTokens;

  const emitRows = (pending: string[]) => {
    while (pending.length > 0) {
      let take = pending.length;
      let candidate = [prefix, ...pending.slice(0, take)].join("\n");
      while (take > 1 && countTokens(candidate) > budget) {
        take--;
        candidate = [prefix, ...pending.slice(0, take)].join("\n");
      }
      if (countTokens(candidate) <= budget) {
        units.push({ text: candidate, kind: "table", standalone: false });
      } else {
        units.push(...oversizedTableRowUnits(
          table.header,
          pending[0]!,
          budget,
          countTokens,
        ));
        take = 1;
      }
      pending = pending.slice(take);
    }
  };
  const flush = () => {
    if (rows.length === 0) return;
    emitRows(rows);
    rows = [];
    estimatedTokens = prefixTokens;
  };

  for (const row of table.rows) {
    const rowTokens = countTokens(row) + separatorTokens;
    if (rows.length > 0 && estimatedTokens + rowTokens > budget) flush();
    rows.push(row);
    estimatedTokens += rowTokens;
  }
  flush();
  if (units.length === 0) units.push({ text: prefix, kind: "table", standalone: false });
  return units;
}

function oversizedTableRowUnits(
  header: string,
  row: string,
  budget: number,
  countTokens: TokenCounter,
): MarkdownUnit[] {
  const headers = tableCells(header);
  const cells = tableCells(row);
  const fields = headers.map((name, index) => `${name || `Column ${index + 1}`}: ${cells[index] ?? ""}`);
  const units: MarkdownUnit[] = [];
  let group: string[] = [];
  const label = "Table row excerpt:\n\n";
  const flush = () => {
    if (group.length === 0) return;
    units.push({ text: label + group.join("\n"), kind: "table", standalone: false });
    group = [];
  };

  for (const field of fields) {
    const candidate = label + [...group, field].join("\n");
    if (countTokens(candidate) <= budget) {
      group.push(field);
      continue;
    }
    flush();
    if (countTokens(label + field) <= budget) {
      group.push(field);
      continue;
    }
    const separator = field.indexOf(": ") + 2;
    const fieldPrefix = `${label}${field.slice(0, separator)}`;
    for (const piece of splitWithRepeatedPrefix(
      field.slice(separator),
      fieldPrefix,
      budget,
      countTokens,
    )) {
      units.push({ text: piece, kind: "table", standalone: false });
    }
  }
  flush();
  return units;
}

function splitWithRepeatedPrefix(
  value: string,
  prefix: string,
  budget: number,
  countTokens: TokenCounter,
): string[] {
  const characters = Array.from(value);
  const pieces: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let low = start + 1;
    let high = characters.length;
    let best = start;
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      const candidate = prefix + characters.slice(start, end).join("");
      if (countTokens(candidate) <= budget) {
        best = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }
    if (best === start) best = start + 1;
    pieces.push(prefix + characters.slice(start, best).join(""));
    start = best;
  }
  return pieces;
}

function protectInlineCode(text: string): { text: string; restore: (text: string) => string } {
  const ranges: Array<{ start: number; end: number; value: string }> = [];
  for (const match of text.matchAll(/(`+)([\s\S]*?)\1/g)) {
    const start = match.index;
    ranges.push({ start, end: start + match[0].length, value: match[0] });
  }
  if (ranges.length === 0) return { text, restore: (candidate) => candidate };

  const replacements = new Map<string, string>();
  let protectedText = "";
  let cursor = 0;
  let marker = 0xf0000;
  for (const range of ranges) {
    protectedText += text.slice(cursor, range.start);
    let character = String.fromCodePoint(marker++);
    while (text.includes(character)) character = String.fromCodePoint(marker++);
    replacements.set(character, range.value);
    protectedText += character;
    cursor = range.end;
  }
  protectedText += text.slice(cursor);
  const markerPattern = /[\u{F0000}-\u{FFFFD}]/gu;
  return {
    text: protectedText,
    restore: (candidate) => candidate.replace(
      markerPattern,
      (character) => replacements.get(character) ?? character,
    ),
  };
}

async function markdownCodeBlocks(text: string): Promise<CodeBlock[]> {
  const fenced = fencedCodeBlocks(text);
  const tree = await parseMarkdownTree(text);
  const nodes: MarkdownNode[] = [];
  visitMarkdown(tree, (node) => {
    if (node.type === "code" && node.position && typeof node.value === "string") nodes.push(node);
  });

  const blocks: CodeBlock[] = [];
  for (const node of nodes) {
    const startOffset = node.position!.start.offset;
    const endOffset = node.position!.end.offset;
    if (startOffset === undefined || endOffset === undefined) continue;
    const start = text.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
    const nextNewline = text.indexOf("\n", endOffset);
    const end = nextNewline === -1 ? text.length : nextNewline + 1;
    if (fenced.some((block) => start < block.end && end > block.start)) continue;
    const language = normalizeLanguage(node.lang ?? "text");
    const info = [node.lang, node.meta].filter(Boolean).join(" ") || language;

    if (node.lang === null && containsLiteralFence(node.value!)) {
      const parts = embeddedCodeParts(node.value!);
      blocks.push({
        start,
        end,
        language: "text",
        info: "text",
        content: node.value!,
        parts,
      });
    } else {
      blocks.push({ start, end, language, info, content: node.value! });
    }
  }

  return [...fenced, ...blocks]
    .sort((a, b) => a.start - b.start)
    .filter((block, index, all) => index === 0 || block.start >= all[index - 1]!.end);
}

/**
 * CommonMark only permits up to three spaces before a fence, while MDX-style
 * documentation often indents examples beneath components such as `<Tab>`.
 * Scan fences lexically so those examples remain real, self-contained code
 * blocks. The matching closer must use the same marker and at least the
 * opener's length, which also protects longer fences containing backticks.
 */
function fencedCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = [...text.matchAll(/.*(?:\r?\n|$)/g)].filter((match) => match[0] !== "");
  let open: {
    start: number;
    indent: string;
    marker: string;
    info: string;
    content: string[];
  } | null = null;

  for (const lineMatch of lines) {
    const rawWithNewline = lineMatch[0];
    const raw = rawWithNewline.replace(/\r?\n$/, "");
    if (!open) {
      const opener = /^([\t ]*)(`{3,}|~{3,})([^\r\n]*)$/.exec(raw);
      if (!opener) continue;
      // Backtick fence info strings cannot themselves contain a backtick.
      if (opener[2]![0] === "`" && opener[3]!.includes("`")) continue;
      open = {
        start: lineMatch.index!,
        indent: opener[1]!,
        marker: opener[2]!,
        info: opener[3]!.trim(),
        content: [],
      };
      continue;
    }

    const closer = /^[\t ]*(`+|~+)[\t ]*$/.exec(raw);
    if (
      closer &&
      closer[1]![0] === open.marker[0] &&
      closer[1]!.length >= open.marker.length
    ) {
      const language = normalizeLanguage(open.info.split(/\s+/, 1)[0] || "text");
      blocks.push({
        start: open.start,
        end: lineMatch.index! + rawWithNewline.length,
        language,
        info: open.info || language,
        content: open.content.join("\n"),
      });
      open = null;
      continue;
    }

    open.content.push(raw.startsWith(open.indent) ? raw.slice(open.indent.length) : raw);
  }

  if (open) {
    const language = normalizeLanguage(open.info.split(/\s+/, 1)[0] || "text");
    blocks.push({
      start: open.start,
      end: text.length,
      language,
      info: open.info || language,
      content: open.content.join("\n"),
    });
  }
  return blocks;
}

let markdownTreeParser: Promise<(text: string) => MarkdownNode> | null = null;

async function parseMarkdownTree(text: string): Promise<MarkdownNode> {
  markdownTreeParser ??= Promise.all([
    import("unified"),
    import("remark-parse"),
  ]).then(([{ unified }, { default: remarkParse }]) => {
    const parser = unified().use(remarkParse);
    return (source: string) => parser.parse(source) as MarkdownNode;
  });
  return (await markdownTreeParser)(text);
}

function visitMarkdown(node: MarkdownNode, visitor: (node: MarkdownNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visitMarkdown(child, visitor);
}

function containsLiteralFence(value: string): boolean {
  return /^(`{3,}|~{3,})[^\n]*$/m.test(value);
}

/**
 * Some generated Markdown indents a sequence of fenced examples as one
 * CommonMark indented-code node. Recover the inner examples, but keep one
 * source range so no raw fence text leaks back into prose.
 */
function embeddedCodeParts(
  value: string,
): Array<Pick<CodeBlock, "language" | "info" | "content">> {
  const lines = value.split(/\r?\n/);
  const recovered: Array<Omit<CodeBlock, "start" | "end">> = [];
  let open: { character: string; length: number; info: string; lines: string[] } | null = null;
  let outside: string[] = [];
  const flushOutside = () => {
    const content = outside.join("\n").trim();
    if (content) recovered.push({ language: "text", info: "text", content });
    outside = [];
  };

  for (const line of lines) {
    if (!open) {
      const match = /^(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
      if (match) {
        flushOutside();
        open = {
          character: match[1]![0]!,
          length: match[1]!.length,
          info: match[2]!.trim(),
          lines: [],
        };
      } else {
        outside.push(line);
      }
      continue;
    }

    const closing = /^(`+|~+)[\t ]*$/.exec(line.trim());
    if (closing && closing[1]![0] === open.character && closing[1]!.length >= open.length) {
      const language = normalizeLanguage(open.info.split(/\s+/, 1)[0] || "text");
      recovered.push({ language, info: open.info || language, content: open.lines.join("\n") });
      open = null;
    } else {
      open.lines.push(line);
    }
  }

  if (open) {
    const language = normalizeLanguage(open.info.split(/\s+/, 1)[0] || "text");
    recovered.push({ language, info: open.info || language, content: open.lines.join("\n") });
  }
  flushOutside();
  if (recovered.length === 0) {
    return [{ language: "text", info: "text", content: value }];
  }
  return recovered;
}

function normalizeLanguage(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized === "js") return "javascript";
  if (normalized === "ts") return "typescript";
  if (normalized === "py") return "python";
  if (normalized === "htm") return "html";
  return normalized || "text";
}

function codeUnits(
  block: CodeBlock,
  budget: number,
  countTokens: TokenCounter,
): MarkdownUnit[] {
  const whole = renderCodeBlock(block, block.content.trimEnd());
  if (countTokens(whole) <= budget) {
    return [{ text: whole, kind: "code", standalone: false }];
  }

  if (block.language === "json") {
    const json = parseJsonExample(block.content);
    if (json.ok) {
      const fragments = splitJsonValue(json.value, "$", block, budget, countTokens);
      if (fragments.length > 1 || countTokens(renderJsonFragment(block, fragments[0]!)) <= budget) {
        return fragments.map((fragment) => ({
          text: renderJsonFragment(block, fragment),
          kind: "code",
          standalone: false,
        }));
      }
    }
  }

  const contentBudget = Math.max(
    Math.min(32, Math.max(1, Math.floor(budget * 0.6))),
    budget - countTokens(`Code excerpt (${block.language}), part 999 of 999\n\n\`\`\`${block.info}\n\n\`\`\``),
  );
  const fragments = splitCodeContent(block.content, contentBudget, block.language, countTokens);
  return fragments.map((fragment, index) => ({
    text: renderCodeBlock(
      block,
      fragment,
      `Code excerpt (${block.language}), part ${index + 1} of ${fragments.length}`,
    ),
    kind: "code",
    standalone: false,
  }));
}

function renderCodeBlock(block: CodeBlock, content: string, label?: string): string {
  const fence = /^```/m.test(content) ? "~~~~" : "```";
  const info = block.info || block.language;
  const rendered = `${fence}${info}\n${content.trimEnd()}\n${fence}`;
  return label ? `${label}\n\n${rendered}` : rendered;
}

function parseJsonExample(content: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content.trim()) as unknown };
  } catch {
    return { ok: false };
  }
}

function renderJsonFragment(block: CodeBlock, fragment: JsonFragment): string {
  const path = fragment.path.length <= 240
    ? fragment.path
    : `${fragment.path.slice(0, 116)}…${fragment.path.slice(-116)}`;
  return renderCodeBlock(
    block,
    JSON.stringify(fragment.value, null, 2),
    `JSON excerpt: ${path}`,
  );
}

function splitJsonValue(
  value: unknown,
  path: string,
  block: CodeBlock,
  budget: number,
  countTokens: TokenCounter,
): JsonFragment[] {
  const whole = { path, value };
  if (countTokens(renderJsonFragment(block, whole)) <= budget) return [whole];

  if (Array.isArray(value) && value.length > 0) {
    const out: JsonFragment[] = [];
    let group: unknown[] = [];
    let groupStart = 0;
    const flush = () => {
      if (group.length === 0) return;
      const end = groupStart + group.length - 1;
      out.push({ path: `${path}[${groupStart}${end === groupStart ? "" : `…${end}`}]`, value: group });
      group = [];
    };

    for (let index = 0; index < value.length; index++) {
      const candidate = [...group, value[index]];
      const candidatePath = `${path}[${groupStart}${index === groupStart ? "" : `…${index}`}]`;
      if (countTokens(renderJsonFragment(block, { path: candidatePath, value: candidate })) <= budget) {
        group = candidate;
        continue;
      }
      flush();
      groupStart = index;
      const single = { path: `${path}[${index}]`, value: value[index] };
      if (countTokens(renderJsonFragment(block, single)) <= budget) {
        group = [value[index]];
      } else {
        out.push(...splitJsonValue(value[index], single.path, block, budget, countTokens));
        groupStart = index + 1;
      }
    }
    flush();
    return out;
  }

  if (isJsonObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [whole];
    const out: JsonFragment[] = [];
    let group: Record<string, unknown> = {};
    const flush = () => {
      if (Object.keys(group).length === 0) return;
      out.push({ path, value: group });
      group = {};
    };

    for (const [key, child] of entries) {
      const candidate = { ...group, [key]: child };
      if (countTokens(renderJsonFragment(block, { path, value: candidate })) <= budget) {
        group = candidate;
        continue;
      }
      flush();
      const childPath = `${path}[${JSON.stringify(key)}]`;
      const single = { path, value: { [key]: child } };
      if (countTokens(renderJsonFragment(block, single)) <= budget) {
        group = { [key]: child };
      } else {
        out.push(...splitJsonValue(child, childPath, block, budget, countTokens));
      }
    }
    flush();
    return out;
  }

  return splitJsonScalar(value, path, block, budget, countTokens);
}

/** A scalar has no semantic child boundary. Preserve it when possible, then
 * use bounded, explicitly labelled string excerpts as the hard fallback. */
function splitJsonScalar(
  value: unknown,
  path: string,
  block: CodeBlock,
  budget: number,
  countTokens: TokenCounter,
): JsonFragment[] {
  const source = typeof value === "string" ? value : JSON.stringify(value);
  if (!source) return [{ path, value }];
  const fragments: JsonFragment[] = [];
  let start = 0;
  const emptyOverhead = countTokens(renderJsonFragment(block, {
    path: `${path} (characters 1–1)`,
    value: "",
  }));
  const availableTokens = Math.max(1, budget - emptyOverhead);
  const sourceTokens = Math.max(1, countTokens(source));
  const estimatedSpan = Math.max(
    1,
    Math.floor((source.length / sourceTokens) * availableTokens * 0.85),
  );

  while (start < source.length) {
    const fits = (end: number) => {
      const candidate = {
        path: `${path} (characters ${start + 1}–${end})`,
        value: source.slice(start, end),
      };
      return countTokens(renderJsonFragment(block, candidate)) <= budget;
    };
    let best = Math.min(source.length, start + estimatedSpan);
    let low = start + 1;
    let high = best;
    if (fits(best)) {
      low = best + 1;
      high = Math.min(source.length, start + Math.ceil(estimatedSpan / 0.85));
    } else {
      best = start;
    }
    while (low <= high) {
      const end = Math.floor((low + high) / 2);
      if (fits(end)) {
        best = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
    }

    // Normal plans leave ample room for the label and fences. If an extreme
    // user-supplied budget does not, make forward progress and let the final
    // atomic guard divide the rendered unit.
    if (best === start) best = start + 1;
    fragments.push({
      path: `${path} (characters ${start + 1}–${best})`,
      value: source.slice(start, best),
    });
    start = best;
  }
  return fragments;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCodeContent(
  content: string,
  budget: number,
  language: string,
  countTokens: TokenCounter,
): string[] {
  const groups = logicalCodeGroups(content, language);
  const chunks: string[] = [];
  let current = "";

  const append = (piece: string) => {
    const candidate = current ? `${current}\n${piece}` : piece;
    if (countTokens(candidate) <= budget) {
      current = candidate;
      return;
    }
    if (current) chunks.push(current.trimEnd());
    current = "";
    if (countTokens(piece) <= budget) {
      current = piece;
      return;
    }
    const lines = piece.split("\n");
    for (const line of lines) {
      const lineCandidate = current ? `${current}\n${line}` : line;
      if (countTokens(lineCandidate) <= budget) {
        current = lineCandidate;
      } else {
        if (current) chunks.push(current.trimEnd());
        const lineParts = recursiveSplit(line, {
          separators: [" ", ""],
          chunkSize: budget,
          overlap: 0,
          countTokens,
        });
        chunks.push(...lineParts.slice(0, -1));
        current = lineParts.at(-1) ?? "";
      }
    }
  };

  for (const group of groups) append(group);
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks.filter(Boolean);
}

function logicalCodeGroups(content: string, language: string): string[] {
  const lines = content.trimEnd().split("\n");
  const groups: string[] = [];
  let current: string[] = [];
  const boundary = codeBoundaryPattern(language);

  for (const line of lines) {
    const startsBoundary = current.length > 0 && (line.trim() === "" || boundary.test(line));
    if (startsBoundary) {
      groups.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) groups.push(current.join("\n"));
  return groups;
}

function codeBoundaryPattern(language: string): RegExp {
  if (["javascript", "typescript", "jsx", "tsx"].includes(language)) {
    return /^(?:export\s+)?(?:async\s+)?(?:class|function|const|let|var|import|document\.)\b/;
  }
  if (language === "python") return /^(?:class|def|async\s+def)\b/;
  if (language === "css") return /^(?:@|[^\s].*\{\s*$)/;
  if (["html", "jinja"].includes(language)) return /^(?:<[^/!]|\{%\s*(?:block|macro|if|for|require))/;
  return /$a/;
}

function packMarkdownUnits(
  units: MarkdownUnit[],
  budget: number,
  overlap: number,
  countTokens: TokenCounter,
): string[] {
  const out: string[] = [];
  let current: MarkdownUnit[] = [];
  const joined = (items: MarkdownUnit[]) => items.map((item) => item.text).join("\n\n").trim();
  const flush = () => {
    const text = joined(current);
    if (text) out.push(text);
  };

  for (const unit of units) {
    if (unit.standalone || countTokens(unit.text) > budget) {
      flush();
      current = [];
      out.push(...hardBoundedPieces(unit.text, budget, countTokens));
      continue;
    }

    const candidate = joined([...current, unit]);
    if (!current.length || countTokens(candidate) <= budget) {
      current.push(unit);
      continue;
    }

    const previous = current;
    flush();
    current = trailingProseOverlap(previous, overlap, countTokens);
    while (current.length > 0 && countTokens(joined([...current, unit])) > budget) current.shift();
    current.push(unit);
  }
  flush();
  return out;
}

function hardBoundedPieces(
  text: string,
  budget: number,
  countTokens: TokenCounter,
): string[] {
  if (countTokens(text) <= budget) return [text.trim()];
  const initial = recursiveSplit(text, {
    separators: ["\n\n", "\n", " ", ""],
    chunkSize: budget,
    overlap: 0,
    countTokens,
  });
  const bounded: string[] = [];
  for (const piece of initial) {
    if (countTokens(piece) <= budget) {
      if (piece.trim()) bounded.push(piece.trim());
      continue;
    }
    let rest = piece;
    while (rest) {
      let low = 1;
      let high = rest.length;
      let best = 0;
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        if (countTokens(rest.slice(0, end)) <= budget) {
          best = end;
          low = end + 1;
        } else {
          high = end - 1;
        }
      }
      if (best === 0) best = 1;
      const fragment = rest.slice(0, best).trim();
      if (fragment) bounded.push(fragment);
      rest = rest.slice(best);
    }
  }
  return bounded;
}

function trailingProseOverlap(
  units: MarkdownUnit[],
  overlap: number,
  countTokens: TokenCounter,
): MarkdownUnit[] {
  if (overlap <= 0) return [];
  const carry: MarkdownUnit[] = [];
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!;
    if (unit.kind !== "prose") break;
    const candidate = [unit, ...carry];
    if (countTokens(candidate.map((item) => item.text).join("\n\n")) > overlap) break;
    carry.unshift(unit);
  }
  return carry;
}
