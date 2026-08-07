import fsp from "node:fs/promises";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { splitMarkdownByHeaders } from "./markdown.js";
import { ParsedDocument, ParsedSection } from "./types.js";

const REMOVE_SELECTORS = [
  "nav",
  "aside",
  "footer",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "form",
  "dialog",
  "[hidden]",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
  "[role='complementary']",
].join(",");

interface HtmlCandidate {
  html: string;
  origin: "document" | "embedded-json";
}

interface SelectedContent extends HtmlCandidate {
  $: CheerioAPI;
  root: Cheerio<AnyNode>;
  score: number;
}

/**
 * Parse a webpage, including captures stored under a misleading extension.
 * The result remains typed as HTML, but each section contains normalized
 * Markdown so downstream chunking can preserve the recovered structure.
 */
export async function parseHtml(sourcePath: string): Promise<ParsedDocument> {
  const raw = await readHtml(sourcePath);
  const { markdown, origin } = await extractMainContent(raw);
  const split = await splitMarkdownByHeaders(markdown);
  const sections: ParsedSection[] = split.map((section) => {
    const headerPath = Array.isArray(section.meta.headerPath)
      ? section.meta.headerPath.filter((value): value is string => typeof value === "string")
      : [];
    return {
      ...section,
      meta: {
        ...section.meta,
        heading: headerPath.at(-1),
        sourceFormat: "html",
        structuralFormat: "markdown",
        extractionOrigin: origin,
      },
    };
  });

  return { sourcePath, contentType: "html", sections };
}

async function readHtml(sourcePath: string): Promise<string> {
  try {
    return await fsp.readFile(sourcePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }
}

async function extractMainContent(
  raw: string,
): Promise<{ markdown: string; origin: HtmlCandidate["origin"] }> {
  let load: typeof import("cheerio").load;
  try {
    ({ load } = await import("cheerio"));
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to load cheerio: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  const candidates: HtmlCandidate[] = [{ html: raw, origin: "document" }];
  for (const html of embeddedHtmlCandidates(raw)) {
    candidates.push({ html, origin: "embedded-json" });
  }

  let selected: SelectedContent | null = null;
  for (const candidate of deduplicateCandidates(candidates)) {
    const $ = load(candidate.html);
    stripPageChrome($);
    const choice = selectPrimaryRoot($);
    if (!choice || (selected && choice.score <= selected.score)) continue;
    selected = { ...candidate, $, ...choice };
  }

  if (!selected) {
    throw new AutoEmbedError(
      "No readable main content was found in the webpage capture.",
      ExitCode.Parser,
      "Save the article itself as HTML or Markdown instead of an application shell.",
    );
  }

  const markdown = normalizeMarkdown(renderChildren(selected.$, selected.root)).trim();
  if (!markdown) {
    throw new AutoEmbedError("The webpage's main content was empty.", ExitCode.Parser);
  }
  return { markdown, origin: selected.origin };
}

/** Find HTML stored inside serialized application state without knowing the
 * framework or property names. Only rich, document-like strings qualify. */
function embeddedHtmlCandidates(raw: string): string[] {
  const found: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 2 || trimmed.length > 25_000_000) continue;
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) &&
        !(trimmed.startsWith("[") && trimmed.endsWith("]"))) continue;
    try {
      collectHtmlStrings(JSON.parse(trimmed) as unknown, found, { visited: 0 });
    } catch {
      // Web captures commonly contain JavaScript and CSS lines that resemble
      // JSON. A failed standalone-line parse simply is not an embedded state.
    }
  }
  for (const match of raw.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const serialized = match[1]!.trim();
    if (!serialized || serialized.length > 25_000_000) continue;
    try {
      collectHtmlStrings(JSON.parse(serialized) as unknown, found, { visited: 0 });
    } catch {
      // Executable JavaScript is intentionally ignored. Only pure serialized
      // state is eligible for recursive content recovery.
    }
  }
  return found;
}

function stripPageChrome($: CheerioAPI): void {
  $(REMOVE_SELECTORS).remove();
  $("header").each((_, header) => {
    // An article-local header often owns its title/byline. Site headers and
    // application toolbars do not belong to the primary document.
    if ($(header).closest("article").length === 0) $(header).remove();
  });
}

function collectHtmlStrings(
  value: unknown,
  out: string[],
  state: { visited: number },
): void {
  if (state.visited++ > 200_000 || out.length >= 128) return;
  if (typeof value === "string") {
    if (value.length >= 200 && looksLikeStructuredHtml(value)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectHtmlStrings(child, out, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectHtmlStrings(child, out, state);
  }
}

function looksLikeStructuredHtml(value: string): boolean {
  const blockTags = value.match(/<(?:article|main|h[1-6]|p|pre|table|ul|ol)\b/gi)?.length ?? 0;
  return blockTags >= 3 && /<(?:article|main|h[1-6])\b/i.test(value);
}

function deduplicateCandidates(candidates: HtmlCandidate[]): HtmlCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.html)) return false;
    seen.add(candidate.html);
    return true;
  });
}

function selectPrimaryRoot(
  $: CheerioAPI,
): { root: Cheerio<AnyNode>; score: number } | null {
  const articleRoots: Array<Cheerio<AnyNode>> = [];
  const mainRoots: Array<Cheerio<AnyNode>> = [];
  const fallbackRoots: Array<Cheerio<AnyNode>> = [];
  const seen = new Set<AnyNode>();
  const add = (target: Array<Cheerio<AnyNode>>, selection: Cheerio<AnyNode>) => {
    selection.each((_, node) => {
      if (seen.has(node)) return;
      seen.add(node);
      target.push($(node));
    });
  };

  add(articleRoots, $("article"));
  if (articleRoots.length === 1) {
    const article = bestRoot(articleRoots);
    if (article) return article;
  }
  add(mainRoots, $("[role='main']"));
  add(mainRoots, $("main"));
  add(fallbackRoots, $("body"));
  if (fallbackRoots.length === 0) add(fallbackRoots, $.root());

  // A readable semantic root is a stronger signal than a larger body. App
  // shells and repository pages often surround the article with sidebars
  // containing enough headings and links to outscore the real document.
  return bestRoot(mainRoots) ?? bestRoot(articleRoots) ?? bestRoot(fallbackRoots);
}

function bestRoot(roots: Array<Cheerio<AnyNode>>): { root: Cheerio<AnyNode>; score: number } | null {
  let best: { root: Cheerio<AnyNode>; score: number } | null = null;
  for (const root of roots) {
    const score = scoreRoot(root);
    if (score <= 0 || (best && score <= best.score)) continue;
    best = { root, score };
  }
  return best;
}

function scoreRoot(root: Cheerio<AnyNode>): number {
  const text = collapseWhitespace(root.text());
  if (text.length < 40) return 0;
  const node = root.get(0);
  const tag = node && "name" in node ? node.name.toLowerCase() : "";
  const headings = root.find("h1,h2,h3,h4,h5,h6").length;
  const paragraphs = root.find("p").length;
  const code = root.find("pre").length;
  const lists = root.find("li").length;
  const tables = root.find("table").length;
  const links = collapseWhitespace(root.find("a").text()).length;
  const linkDensity = links / Math.max(1, text.length);
  const semanticBonus = tag === "article" ? 5_000 : tag === "main" ? 3_000 : 0;
  const roleBonus = root.attr("role") === "main" ? 2_000 : 0;
  const structure = headings * 350 + paragraphs * 35 + code * 180 + lists * 12 + tables * 120;
  const lengthScore = Math.min(text.length, 100_000) / 8;
  const navigationPenalty = linkDensity > 0.45 ? 4_000 : linkDensity * 1_000;
  return semanticBonus + roleBonus + structure + lengthScore - navigationPenalty;
}

function renderChildren($: CheerioAPI, parent: Cheerio<AnyNode>): string {
  return parent.contents().toArray().map((node) => renderNode($, node, 0)).join("");
}

function renderNode($: CheerioAPI, node: AnyNode, listDepth: number): string {
  if (node.type === "text") return node.data.replace(/\s+/g, " ");
  if (!("name" in node)) return "";
  const tag = node.name.toLowerCase();
  const element = $(node);
  const children = () => element.contents().toArray()
    .map((child) => renderNode($, child, listDepth))
    .join("");

  if (["script", "style", "noscript", "template", "svg", "canvas"].includes(tag)) return "";
  if (/^h[1-6]$/.test(tag)) {
    const depth = Number(tag[1]);
    return `\n\n${"#".repeat(depth)} ${collapseWhitespace(element.text())}\n\n`;
  }
  if (tag === "pre") return renderPre(element);
  if (tag === "code") return renderInlineCode(element.text());
  if (tag === "ul" || tag === "ol") return renderList($, element, listDepth, tag === "ol");
  if (tag === "table") return renderTable($, element);
  if (tag === "blockquote") {
    const body = normalizeMarkdown(children()).split("\n").map((line) => `> ${line}`).join("\n");
    return `\n\n${body}\n\n`;
  }
  if (tag === "a") {
    const label = collapseWhitespace(element.text());
    const href = element.attr("href")?.trim();
    return href && label ? `[${escapeBrackets(label)}](${href})` : label;
  }
  if (tag === "img") {
    const alt = element.attr("alt")?.trim() ?? "";
    const src = element.attr("src")?.trim();
    return src ? `![${escapeBrackets(alt)}](${src})` : alt;
  }
  if (tag === "br") return "\n";
  if (tag === "hr") return "\n\n---\n\n";
  if (tag === "strong" || tag === "b") return `**${children().trim()}**`;
  if (tag === "em" || tag === "i") return `*${children().trim()}*`;
  if (tag === "del" || tag === "s") return `~~${children().trim()}~~`;
  if (tag === "p") return `\n\n${children().trim()}\n\n`;
  if (["article", "main", "section", "div", "body", "details", "summary", "dl", "dt", "dd"].includes(tag)) {
    return `\n\n${children()}\n\n`;
  }
  return children();
}

function renderPre(element: Cheerio<AnyNode>): string {
  const content = element.text().replace(/^\n|\n$/g, "");
  const ancestorClasses = element.parents().slice(0, 4).toArray()
    .map((parent) => parent.type === "tag" ? parent.attribs.class : undefined);
  const classes = [
    element.attr("class"),
    element.find("code").first().attr("class"),
    ...ancestorClasses,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  const language = /(?:language-|highlight-source-)([\w+-]+)/i.exec(classes)?.[1] ?? "text";
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `\n\n${fence}${normalizeLanguage(language)}\n${content.trimEnd()}\n${fence}\n\n`;
}

function renderInlineCode(text: string): string {
  const content = collapseWhitespace(text);
  if (!content) return "";
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  return `${fence}${content}${fence}`;
}

function renderList(
  $: CheerioAPI,
  list: Cheerio<AnyNode>,
  depth: number,
  ordered: boolean,
): string {
  const lines: string[] = [];
  list.children("li").each((index, item) => {
    const li = $(item);
    const nested = li.children("ul,ol").toArray();
    const nestedSet = new Set<AnyNode>(nested);
    const own = li.contents().toArray()
      .filter((child) => !nestedSet.has(child))
      .map((child) => renderNode($, child, depth + 1))
      .join("");
    const prefix = ordered ? `${index + 1}. ` : "- ";
    const indent = "  ".repeat(depth);
    const body = normalizeMarkdown(own).replace(/\n+/g, " ");
    if (body) lines.push(`${indent}${prefix}${body}`);
    for (const child of nested) {
      lines.push(renderNode($, child, depth + 1).trimEnd());
    }
  });
  return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
}

function renderTable($: CheerioAPI, table: Cheerio<AnyNode>): string {
  const rows: string[][] = [];
  table.find("tr").each((_, row) => {
    const cells = $(row).children("th,td").toArray().map((cell) =>
      collapseWhitespace($(cell).text()).replace(/\|/g, "\\|"),
    );
    if (cells.length > 0) rows.push(cells);
  });
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const header = normalized[0]!;
  const separator = Array.from({ length: width }, () => "---");
  const lines = [header, separator, ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`);
  return `\n\n${lines.join("\n")}\n\n`;
}

function normalizeLanguage(language: string): string {
  const normalized = language.toLowerCase();
  if (normalized === "js") return "javascript";
  if (normalized === "ts") return "typescript";
  if (normalized === "py") return "python";
  if (normalized === "rb") return "ruby";
  if (normalized === "sh" || normalized === "shell") return "bash";
  return normalized || "text";
}

function normalizeMarkdown(value: string): string {
  const output: string[] = [];
  let fence: { character: string; length: number } | null = null;
  for (const rawLine of value.split(/\r?\n/)) {
    if (fence) {
      output.push(rawLine.replace(/[ \t]+$/, ""));
      const closing = /^\s*(`+|~+)\s*$/.exec(rawLine);
      if (closing && closing[1]![0] === fence.character && closing[1]!.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const trimmed = rawLine.trim();
    const opening = /^(`{3,}|~{3,})[^`~]*$/.exec(trimmed);
    if (opening) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      output.push(trimmed);
    } else if (/^\s+(?:[-+*]|\d+[.)])\s+/.test(rawLine)) {
      output.push(rawLine.trimEnd());
    } else {
      output.push(trimmed);
    }
  }
  return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeBrackets(value: string): string {
  return value.replace(/([\[\]])/g, "\\$1");
}
