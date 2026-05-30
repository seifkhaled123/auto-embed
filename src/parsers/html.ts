import fsp from "node:fs/promises";
import { AutoEmbedError, ExitCode } from "../errors.js";
import { ParsedDocument, ParsedSection } from "./types.js";

const STRIP_SELECTORS = ["nav", "aside", "footer", "header", "script", "style", "noscript"];
const BLOCK_SELECTORS = ["article", "main > section", "main > div", "section", "article > div"];

export async function parseHtml(sourcePath: string): Promise<ParsedDocument> {
  const raw = await fsp.readFile(sourcePath, "utf8").catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new AutoEmbedError(`File not found: ${sourcePath}`, ExitCode.UserConfig);
    }
    throw new AutoEmbedError(
      `Failed to read ${sourcePath}: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  });

  let load: typeof import("cheerio").load;
  try {
    ({ load } = await import("cheerio"));
  } catch (err) {
    throw new AutoEmbedError(
      `Failed to load cheerio: ${(err as Error).message}`,
      ExitCode.Parser,
    );
  }

  const $ = load(raw);

  for (const sel of STRIP_SELECTORS) $(sel).remove();

  const root = $("main").length ? $("main") : $("body");
  const sections: ParsedSection[] = [];

  let blocks = root.find(BLOCK_SELECTORS.join(", "));
  if (blocks.length === 0) {
    blocks = root;
  }

  blocks.each((_, el) => {
    const $el = $(el);
    const text = collapseWhitespace($el.text());
    if (!text) return;
    const heading = collapseWhitespace($el.find("h1, h2, h3").first().text());
    const meta: Record<string, unknown> = { tag: (el as { tagName?: string }).tagName ?? "" };
    if (heading) meta.heading = heading;
    sections.push({ text, meta });
  });

  if (sections.length === 0) {
    const fallback = collapseWhitespace(root.text());
    if (fallback) sections.push({ text: fallback, meta: {} });
  }

  return { sourcePath, contentType: "html", sections };
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
