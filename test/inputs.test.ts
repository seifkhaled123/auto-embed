import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandInputArgs } from "../src/commands/inputs.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-inputs-"));
  await fsp.mkdir(path.join(tmp, "docs", "nested"), { recursive: true });
  await fsp.mkdir(path.join(tmp, "docs", "node_modules", "pkg"), { recursive: true });
  await fsp.mkdir(path.join(tmp, "docs", ".git"), { recursive: true });
  await fsp.writeFile(path.join(tmp, "docs", "a.md"), "# A\n");
  await fsp.writeFile(path.join(tmp, "docs", "nested", "b.md"), "# B\n");
  await fsp.writeFile(path.join(tmp, "docs", "nested", "c.txt"), "C\n");
  await fsp.writeFile(path.join(tmp, "docs", "node_modules", "pkg", "hidden.md"), "ignored\n");
  await fsp.writeFile(path.join(tmp, "docs", ".git", "config"), "ignored\n");
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("expandInputArgs", () => {
  it("expands a quoted glob into absolute, sorted files", async () => {
    const files = await expandInputArgs([path.join(tmp, "docs", "**", "*.md")]);
    expect(files).toEqual([
      path.join(tmp, "docs", "a.md"),
      path.join(tmp, "docs", "nested", "b.md"),
    ]);
  });

  it("recurses through directories with safe default ignores", async () => {
    const files = await expandInputArgs([path.join(tmp, "docs")]);
    expect(files).toEqual([
      path.join(tmp, "docs", "a.md"),
      path.join(tmp, "docs", "nested", "b.md"),
      path.join(tmp, "docs", "nested", "c.txt"),
    ]);
  });

  it("deduplicates overlaps between explicit, glob, and directory inputs", async () => {
    const explicit = path.join(tmp, "docs", "a.md");
    const files = await expandInputArgs([
      explicit,
      path.join(tmp, "docs", "*.md"),
      path.join(tmp, "docs"),
    ]);
    expect(files.filter((file) => file === explicit)).toHaveLength(1);
    expect(files).toHaveLength(3);
  });

  it("allows an explicitly named file inside an ignored directory", async () => {
    const explicit = path.join(tmp, "docs", "node_modules", "pkg", "hidden.md");
    await expect(expandInputArgs([explicit])).resolves.toEqual([explicit]);
  });

  it.skipIf(process.platform === "win32")(
    "refuses to recurse through an explicitly named symlink directory",
    async () => {
      const link = path.join(tmp, "linked-docs");
      await fsp.symlink(path.join(tmp, "docs"), link, "dir");
      await expect(expandInputArgs([link])).rejects.toThrow(/symlinked directory/i);
    },
  );

  it("fails the whole resolution when any input has no matches", async () => {
    await expect(
      expandInputArgs([
        path.join(tmp, "docs", "a.md"),
        path.join(tmp, "docs", "**", "*.pdf"),
      ]),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/matched no files/i),
      hint: expect.stringMatching(/path or glob/i),
    });
  });
});
