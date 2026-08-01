import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "index.js");
const tmp = await mkdtemp(path.join(os.tmpdir(), "auto-embed-cli-"));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

function run(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: tmp,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    expectedStatus,
    `auto-embed ${args.join(" ")} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

try {
  await mkdir(path.join(tmp, "docs", "nested"), { recursive: true });
  await writeFile(path.join(tmp, "docs", "a.md"), "# Alpha\n\nFirst document.\n");
  await writeFile(path.join(tmp, "docs", "nested", "b.txt"), "Second document.\n");
  await writeFile(path.join(tmp, "docs", "nested", "c.notes"), "Unknown text extension.\n");

  assert.equal(run(["--version"]).stdout.trim(), packageJson.version);
  const rootHelp = run([]).stdout;
  assert.match(rootHelp, /Usage: auto-embed/);
  assert.match(rootHelp, /Zero-config CLI/);
  const help = run(["embed", "--help"]).stdout;
  for (const flag of [
    "--collection",
    "--provider",
    "--model",
    "--db",
    "--local",
    "--chunk-size",
    "--overlap",
    "--splitter",
    "--metadata",
    "--plan",
    "--plan-only",
    "--out",
    "--batch-size",
    "--concurrency",
    "--force",
    "--dry-run",
    "--show-chunks",
    "--out-vectors",
    "--yes",
  ]) {
    assert.match(help, new RegExp(flag.replace("-", "\\-")));
  }

  const globDryRun = run([
    "embed",
    "docs/**/*.md",
    "--dry-run",
    "--provider",
    "openai",
    "--model",
    "text-embedding-3-small",
    "--db",
    "chroma",
    "--collection",
    "smoke",
    "--chunk-size",
    "64",
    "--overlap",
    "8",
    "--splitter",
    "recursive",
    "--metadata",
    "env=smoke",
    "--batch-size",
    "2",
    "--concurrency",
    "1",
    "--force",
    "--yes",
    "--verbose",
  ]);
  assert.match(globDryRun.stdout, /plan for a\.md/);
  assert.match(globDryRun.stdout, /env.*smoke/);

  const directoryDryRun = run(["embed", "docs", "--dry-run", "--local"]);
  assert.match(directoryDryRun.stdout, /plan for a\.md/);
  assert.match(directoryDryRun.stdout, /plan for b\.txt/);
  assert.match(directoryDryRun.stderr, /falling back to text parsing/i);

  run(["embed", "docs/**/*.md", "--show-chunks", "--out", "preview.txt"]);
  assert.match(await readFile(path.join(tmp, "preview.txt"), "utf8"), /Exact chunk text|First document/);

  run(["embed", "docs/a.md", "--plan-only", "--out", "plan.json"]);
  const plan = JSON.parse(await readFile(path.join(tmp, "plan.json"), "utf8"));
  assert.equal(plan.version, 1);

  run(["plan", "docs/a.md", "--out", "alias-plan.json"]);
  const aliasPlan = JSON.parse(await readFile(path.join(tmp, "alias-plan.json"), "utf8"));
  assert.equal(aliasPlan.version, 1);

  const conflict = run(["embed", "docs/a.md", "--dry-run", "--show-chunks"], 1);
  assert.match(conflict.stderr, /choose only one/i);

  const exportConflict = run([
    "embed",
    "docs/a.md",
    "--dry-run",
    "--out-vectors",
    "vectors.jsonl",
  ], 1);
  assert.match(exportConflict.stderr, /cannot be combined/i);

  const unmatched = run(["embed", "docs/**/*.pdf", "--dry-run"], 1);
  assert.match(unmatched.stderr, /matched no files/i);

  process.stdout.write("CLI smoke tests passed.\n");
} finally {
  await rm(tmp, { recursive: true, force: true });
}
