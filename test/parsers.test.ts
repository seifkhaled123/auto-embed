import path from "node:path";
import url from "node:url";
import { describe, expect, it } from "vitest";
import { parseFile } from "../src/parsers/index.js";
import { parseCsvRows } from "../src/parsers/text.js";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const fx = (name: string) => path.join(here, "fixtures", "parsers", name);

describe("dispatcher", () => {
  it("throws AutoEmbedError on unsupported extension", async () => {
    await expect(parseFile(fx("nope.xyz"))).rejects.toThrow(/Unsupported file type/);
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
