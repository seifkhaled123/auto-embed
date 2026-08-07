import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parseFile } from "../src/parsers/index.js";
import { splitMarkdownByHeaders } from "../src/parsers/markdown.js";
import { parseCsvRows } from "../src/parsers/text.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fx = (name: string) => path.join(here, "fixtures", "parsers", name);

describe("dispatcher", () => {
  it("uses the supported extension before a numeric download suffix", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-suffixed-"));
    const file = path.join(tmp, "guide.md.14");
    await fsp.writeFile(file, "# Guide\n\n## Install\n\nRun the installer.\n");
    try {
      const doc = await parseFile(file);
      expect(doc.contentType).toBe("markdown");
      expect(doc.sections[0]!.meta.headerPath).toEqual(["Guide", "Install"]);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to recursive text for an unknown text-like extension", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-sniff-"));
    const file = path.join(tmp, "notes.xyz");
    await fsp.writeFile(file, "plain text with an unfamiliar extension\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const doc = await parseFile(file);
      expect(doc.contentType).toBe("text");
      expect(doc.sections[0]!.text).toContain("plain text");
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/falling back to text/i));
    } finally {
      stderr.mockRestore();
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("sniffs structured content when the extension is wrong", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-sniff-"));
    const file = path.join(tmp, "records.data");
    await fsp.writeFile(file, '[{"id":1},{"id":2}]\n');
    try {
      const doc = await parseFile(file);
      expect(doc.contentType).toBe("json");
      expect(doc.sections).toHaveLength(2);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown binary content instead of decoding it as text", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-sniff-"));
    const file = path.join(tmp, "blob.xyz");
    await fsp.writeFile(file, Buffer.from([0, 1, 2, 3, 255, 0, 10]));
    try {
      await expect(parseFile(file)).rejects.toThrow(/unsupported binary file/i);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("throws on missing file", async () => {
    await expect(parseFile(fx("does-not-exist.md"))).rejects.toThrow(/not found|ENOENT/i);
  });
});

describe("text parser", () => {
  it("returns a single section with file contents and contentType 'text'", async () => {
    const doc = await parseFile(fx("sample.txt"));
    expect(doc.contentType).toBe("text");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.text).toContain("quiet observation");
    expect(doc.sections[0]!.text).toContain("delete code");
  });
});

describe("code parser", () => {
  it("returns one section, tags language from extension", async () => {
    const doc = await parseFile(fx("sample.ts"));
    expect(doc.contentType).toBe("code");
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0]!.meta.language).toBe("typescript");
    expect(doc.sections[0]!.text).toContain("class InvoiceQueue");
    expect(doc.sections[0]!.text).toContain("function totalCents");
  });
});

describe("json parser", () => {
  it("emits one section per array element with keyPath meta", async () => {
    const doc = await parseFile(fx("sample.json"));
    expect(doc.contentType).toBe("json");
    expect(doc.sections).toHaveLength(5);
    expect(doc.sections[0]!.meta).toEqual({ keyPath: "[0]", index: 0 });
    expect(doc.sections[0]!.text).toContain("INC-001");
    expect(doc.sections[4]!.text).toContain("INC-005");
  });
});

describe("jsonl parser", () => {
  it("emits one section per non-blank line with line-number meta", async () => {
    const doc = await parseFile(fx("sample.jsonl"));
    expect(doc.contentType).toBe("json");
    expect(doc.sections).toHaveLength(5);
    expect(doc.sections[0]!.meta).toEqual({ line: 1 });
    expect(doc.sections[0]!.text).toContain("page_view");
    expect(doc.sections[3]!.text).toContain("payment_failed");
  });
});

describe("csv parser", () => {
  it("emits one section per data row with columns meta", async () => {
    const doc = await parseFile(fx("sample.csv"));
    expect(doc.contentType).toBe("csv");
    expect(doc.sections).toHaveLength(10);
    const first = doc.sections[0]!;
    expect(first.meta.row).toBe(1);
    const cols = first.meta.columns as Record<string, string>;
    expect(cols.name).toBe("Ada Lovelace");
    expect(cols.department).toBe("Compilers");
    expect(first.text).toContain("name: Ada Lovelace");
  });

  describe("parseCsvRows (internal)", () => {
    it("handles quoted fields and escaped quotes", () => {
      const rows = parseCsvRows('a,b,c\n"x,1","y""q",z\n');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual(["x,1", 'y"q', "z"]);
    });

    it("handles newlines inside quoted fields", () => {
      const rows = parseCsvRows('a,b\n"line1\nline2",ok\n');
      expect(rows).toHaveLength(2);
      expect(rows[1]).toEqual(["line1\nline2", "ok"]);
    });
  });
});

describe("markdown parser", () => {
  it("does not emit a separate chunkable section for a contentless parent heading", async () => {
    const sections = await splitMarkdownByHeaders([
      "# Guide",
      "",
      "## Quickstart",
      "",
      "### Configure",
      "",
      "Useful instructions.",
    ].join("\n"));

    expect(sections).toHaveLength(1);
    expect(sections[0]!.meta.headerPath).toEqual(["Guide", "Quickstart", "Configure"]);
  });

  it("detects a webpage capture stored as .md and extracts embedded main content", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-web-capture-"));
    const file = path.join(tmp, "captured.md");
    const article = [
      '<article class="readme">',
      "<h1>Acme SDK</h1>",
      "<p>The supported client for the Acme API, with enough useful article text to rank as primary content.</p>",
      "<h2>Install</h2>",
      "<ul><li>Install the package</li><li>Set the API key</li></ul>",
      '<pre class="highlight-source-python"><code>client = Acme(\n    token=&quot;secret&quot;\n)</code></pre>',
      "<table><tr><th>Option</th><th>Meaning</th></tr><tr><td>token</td><td>API token</td></tr></table>",
      "</article>",
    ].join("");
    const capture = [
      "<!DOCTYPE html>",
      "<html><head><style>.shell { display: block }</style></head><body>",
      "<nav>Repository navigation</nav>",
      `<script type="application/json">${JSON.stringify({
        featureFlags: ["alpha", "beta"],
        applicationState: { rendered: article },
      }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e")}</script>`,
      "<script>window.__HYDRATION__ = { token: 'do-not-index' }</script>",
      "Application shell duplicate text",
      "</body></html>",
    ].join("\n");
    await fsp.writeFile(file, capture);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const doc = await parseFile(file);
      expect(doc.contentType).toBe("html");
      const all = doc.sections.map((section) => section.text).join("\n");
      expect(all).toContain("# Acme SDK");
      expect(all).toContain("## Install");
      expect(all).toContain("- Install the package");
      expect(all).toContain("```python");
      expect(all).toContain('token="secret"');
      expect(all).toContain("| Option | Meaning |");
      expect(all).not.toMatch(/Repository navigation|featureFlags|HYDRATION|Application shell/);
      expect(doc.sections.every((section) => section.meta.extractionOrigin === "embedded-json")).toBe(true);
    } finally {
      stderr.mockRestore();
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("prefers a readable article over a larger page shell", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-article-"));
    const file = path.join(tmp, "captured.html");
    await fsp.writeFile(file, [
      "<!doctype html><html><body>",
      "<article><h1>Client guide</h1><p>Install and configure the supported API client for production use.</p><h2>Install</h2><p>Run the package installer, then configure credentials.</p></article>",
      "<div><h2>About</h2><p>Repository sidebar</p><h3>Stars</h3><p>433 stars</p><h3>Watchers</h3><p>15 watching</p><h3>Forks</h3><p>126 forks</p></div>",
      "</body></html>",
    ].join(""));
    try {
      const doc = await parseFile(file);
      const all = doc.sections.map((section) => section.text).join("\n");
      expect(all).toContain("# Client guide");
      expect(all).toContain("## Install");
      expect(all).not.toMatch(/Repository sidebar|433 stars|15 watching|126 forks/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it("removes frontmatter before deriving the header hierarchy", async () => {
    const sections = await splitMarkdownByHeaders([
      "> Documentation preamble",
      "",
      "---",
      "id: page-123",
      "---",
      "",
      "# Page title",
      "",
      "Useful content.",
    ].join("\n"));

    expect(sections).toHaveLength(1);
    expect(sections[0]!.meta.headerPath).toEqual(["Page title"]);
    expect(sections[0]!.text).toContain("> Documentation preamble");
    expect(sections[0]!.text).not.toContain("id: page-123");
  });

  it("splits sample.md into header-keyed sections", async () => {
    const doc = await parseFile(fx("sample.md"));
    expect(doc.contentType).toBe("markdown");
    expect(doc.sections.length).toBeGreaterThanOrEqual(6);
    const headerPaths = doc.sections.map((s) => s.meta.headerPath as string[]);
    expect(headerPaths[0]).toEqual(["Onboarding Handbook"]);
    expect(headerPaths).toContainEqual(["Onboarding Handbook", "Setup"]);
    expect(headerPaths).toContainEqual(["Onboarding Handbook", "Setup", "Toolchain"]);
    expect(headerPaths).toContainEqual(["Onboarding Handbook", "Resources"]);
  });

  it("keeps the markdown source intact in each section", async () => {
    const doc = await parseFile(fx("sample.md"));
    const setup = doc.sections.find(
      (s) => JSON.stringify(s.meta.headerPath) === JSON.stringify(["Onboarding Handbook", "Setup"]),
    )!;
    expect(setup.text).toMatch(/^## Setup/);
  });

  it("preserves a fenced code block inside its section", async () => {
    const doc = await parseFile(fx("sample.md"));
    const tool = doc.sections.find(
      (s) =>
        JSON.stringify(s.meta.headerPath) ===
        JSON.stringify(["Onboarding Handbook", "Setup", "Toolchain"]),
    )!;
    expect(tool.text).toContain("```bash");
    expect(tool.text).toContain("node --version");
  });
});

describe("html parser", () => {
  it("strips nav/footer/aside/script/style and yields semantic blocks", async () => {
    const doc = await parseFile(fx("sample.html"));
    expect(doc.contentType).toBe("html");
    expect(doc.sections.length).toBeGreaterThan(0);
    const all = doc.sections.map((s) => s.text).join("\n");
    expect(all).not.toMatch(/Home|About|Contact/);
    expect(all).not.toMatch(/this footer should be stripped/i);
    expect(all).not.toMatch(/console\.log/);
    expect(all).not.toMatch(/Related: Five rules/i);
    expect(all).toContain("Cost of Premature Abstraction");
    expect(all).toContain("three-instance rule");
  });

  it("captures heading metadata when present in a block", async () => {
    const doc = await parseFile(fx("sample.html"));
    const withHeading = doc.sections.filter((s) => typeof s.meta.heading === "string");
    expect(withHeading.length).toBeGreaterThan(0);
  });
});

describe("pdf parser", () => {
  it("emits one section per page with pageNumber + pageCount meta", async () => {
    const doc = await parseFile(fx("sample.pdf"));
    expect(doc.contentType).toBe("pdf");
    expect(doc.sections).toHaveLength(3);
    doc.sections.forEach((s, idx) => {
      expect(s.meta.pageNumber).toBe(idx + 1);
      expect(s.meta.pageCount).toBe(3);
    });
    expect(doc.sections[0]!.text).toMatch(/Quarterly Field Report/);
    expect(doc.sections[1]!.text).toMatch(/page-number metadata/);
  });
});

describe("docx parser", () => {
  it("converts via mammoth and splits the resulting markdown by headers", async () => {
    const doc = await parseFile(fx("sample.docx"));
    expect(doc.contentType).toBe("docx");
    expect(doc.sections.length).toBeGreaterThanOrEqual(3);
    const headers = doc.sections.map((s) => s.meta.headerPath as string[]);
    expect(headers[0]).toEqual(["Release Checklist"]);
    expect(headers).toContainEqual(["Release Checklist", "Pre-flight"]);
    expect(headers).toContainEqual(["Release Checklist", "Smoke test"]);
  });
});
