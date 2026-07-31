import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { chunkSource } from "../src/chunker/index.js";
import { hashFile } from "../src/lockfile.js";
import { parseSource } from "../src/parsers/index.js";
import { EmbedPlan } from "../src/plan/schema.js";

const targetBytes = 128 * 1024 * 1024;
const maxRssMb = Number(process.env.AUTO_EMBED_PERF_MAX_RSS_MB ?? "384");
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-perf-"));

const fixtures = [
  {
    name: "txt",
    file: path.join(tmp, "generated-128mb.txt"),
    line: Buffer.from(
      "A deterministic large-file fixture exercises streaming parse, token-aware chunking, and hashing without retaining source text.\n",
    ),
    splitter: "recursive" as const,
  },
  {
    name: "jsonl",
    file: path.join(tmp, "generated-128mb.jsonl"),
    line: Buffer.from(
      JSON.stringify({
        topic: "deterministic large-file fixture",
        body: "Streaming JSONL parsing retains record boundaries without retaining the entire source. ".repeat(200),
      }) + "\n",
    ),
    splitter: "jsonl" as const,
  },
];

let peakRss = process.memoryUsage().rss;
const sampleMemory = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

async function generate(file: string, line: Buffer): Promise<number> {
  const output = createWriteStream(file, { flags: "w" });
  let written = 0;
  while (written < targetBytes) {
    if (!output.write(line)) await once(output, "drain");
    written += line.length;
  }
  output.end();
  await once(output, "finish");
  return written;
}

async function collectIds(file: string, plan: EmbedPlan): Promise<string[]> {
  const source = await parseSource(file);
  const ids: string[] = [];
  for await (const chunk of chunkSource(source, plan)) {
    ids.push(chunk.id);
    if (ids.length % 500 === 0) sampleMemory();
  }
  sampleMemory();
  return ids;
}

const started = performance.now();
try {
  const results = [];
  for (const fixture of fixtures) {
    const fixtureBytes = await generate(fixture.file, fixture.line);
    process.stdout.write(`generated ${fixture.name} fixture (${fixtureBytes} bytes)\n`);
    sampleMemory();
    const plan: EmbedPlan = {
      version: 1,
      splitter: fixture.splitter,
      chunkSize: 4096,
      overlap: 256,
      metadata: { fixture: `generated-128mb-${fixture.name}` },
      collection: "perf-large",
      embeddingModel: "fake-model",
    };
    const hashA = await hashFile(fixture.file);
    process.stdout.write(`completed first ${fixture.name} streaming hash\n`);
    const first = await collectIds(fixture.file, plan);
    process.stdout.write(`completed first ${fixture.name} chunk pass (${first.length} chunks)\n`);
    const hashB = await hashFile(fixture.file);
    const second = await collectIds(fixture.file, plan);
    process.stdout.write(`completed second ${fixture.name} chunk pass (${second.length} chunks)\n`);

    assert.equal(hashA, hashB);
    assert.deepEqual(second, first);
    assert.ok(first.length > 1_000, `expected many ${fixture.name} chunks, received ${first.length}`);
    results.push({
      format: fixture.name,
      fixtureBytes,
      chunks: first.length,
      deterministicHash: hashA,
    });
    await fsp.rm(fixture.file);
  }

  const rssMb = peakRss / 1024 / 1024;
  assert.ok(
    rssMb <= maxRssMb,
    `peak RSS ${rssMb.toFixed(1)} MB exceeded ${maxRssMb} MB ceiling`,
  );
  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        fixtures: results,
        peakRssMb: Number(rssMb.toFixed(1)),
        ceilingMb: maxRssMb,
        durationSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
