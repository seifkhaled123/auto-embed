import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chunkSource } from "../../src/chunker/index.js";
import { parseSource } from "../../src/parsers/index.js";
import { EmbedPlan } from "../../src/plan/schema.js";
import { rankLexicalTfidf } from "./backend.js";
import { meanMetrics, retrievalMetrics } from "./metrics.js";
import { renderEvaluationHtml } from "./report.js";
import {
  EvalChunk,
  EvalManifest,
  EvalQuery,
  EvaluationResult,
  ExperimentResult,
} from "./types.js";

const defaultManifest = path.resolve("test/fixtures/eval/manifest.json");
const defaultOutput = path.resolve(".auto-embed/eval");

export async function runEvaluation(manifestPath: string = defaultManifest): Promise<EvaluationResult> {
  const rawManifest = await fsp.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest) as EvalManifest;
  validateManifest(manifest);
  const manifestDir = path.dirname(manifestPath);
  const queriesDoc = JSON.parse(
    await fsp.readFile(path.resolve(manifestDir, manifest.queriesFile), "utf8"),
  ) as { version: number; queries: EvalQuery[] };
  if (queriesDoc.version !== 1 || !Array.isArray(queriesDoc.queries)) {
    throw new Error("Evaluation queries must use version 1 with a queries array.");
  }
  const corpusDir = path.resolve(manifestDir, manifest.corpusDir);
  const corpusFiles = (await fsp.readdir(corpusDir))
    .filter((file) => /\.(md|mdx|txt|json|jsonl|csv|html)$/i.test(file))
    .sort(compareText);
  if (corpusFiles.length === 0) throw new Error(`No evaluation corpus files in ${corpusDir}`);

  const experiments: ExperimentResult[] = [];
  for (const experiment of manifest.experiments) {
    const chunks: EvalChunk[] = [];
    for (const sourceName of corpusFiles) {
      const absolutePath = path.join(corpusDir, sourceName);
      const parsed = await parseSource(absolutePath);
      const stableSource = { ...parsed, sourcePath: sourceName };
      const plan: EmbedPlan = {
        version: 1,
        splitter: experiment.splitter,
        chunkSize: experiment.chunkSize,
        overlap: experiment.overlap,
        metadata: {},
        collection: "eval",
        embeddingModel: manifest.backend,
      };
      for await (const chunk of chunkSource(stableSource, plan)) {
        chunks.push({ id: chunk.id, source: sourceName, text: chunk.text, metadata: chunk.meta });
      }
    }
    chunks.sort((a, b) => compareText(a.source, b.source) || compareText(a.id, b.id));

    const queryResults = queriesDoc.queries.map((query) => {
      const relevant = new Set(
        chunks
          .filter((chunk) => query.relevant.some(
            (label) => chunk.source === label.source && chunk.text.toLowerCase().includes(label.contains.toLowerCase()),
          ))
          .map((chunk) => chunk.id),
      );
      if (relevant.size === 0) {
        throw new Error(`Query ${query.id} has no relevant chunks in experiment ${experiment.id}.`);
      }
      const rankedScores = rankLexicalTfidf(query.text, chunks).slice(0, manifest.topK);
      const ranked = rankedScores.map((entry) => {
        const chunk = chunks.find((candidate) => candidate.id === entry.chunkId)!;
        return {
          chunkId: entry.chunkId,
          source: chunk.source,
          score: entry.score,
          relevant: relevant.has(entry.chunkId),
        };
      });
      return {
        queryId: query.id,
        relevantChunkIds: [...relevant].sort(compareText),
        ranked,
        metrics: retrievalMetrics(ranked.map((entry) => entry.chunkId), relevant, manifest.topK),
      };
    });
    experiments.push({
      ...experiment,
      chunkCount: chunks.length,
      metrics: meanMetrics(queryResults.map((query) => query.metrics)),
      queries: queryResults,
    });
  }

  const baseline = experiments.find((experiment) => experiment.id === manifest.baselineExperiment);
  if (!baseline) throw new Error(`Baseline experiment not found: ${manifest.baselineExperiment}`);
  const thresholdStatus = !manifest.thresholds
    ? "not-configured"
    : Object.entries(manifest.thresholds).every(
        ([key, minimum]) => baseline.metrics[key as keyof typeof baseline.metrics] >= minimum,
      )
    ? "pass"
    : "fail";

  return {
    evaluatorVersion: 1,
    manifestHash: crypto.createHash("sha256").update(rawManifest).digest("hex"),
    name: manifest.name,
    backend: manifest.backend,
    topK: manifest.topK,
    baselineExperiment: manifest.baselineExperiment,
    thresholds: manifest.thresholds,
    thresholdStatus,
    experiments,
  };
}

export async function writeEvaluationReports(
  result: EvaluationResult,
  outputDir: string = defaultOutput,
): Promise<{ jsonPath: string; htmlPath: string }> {
  await fsp.mkdir(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "evaluation.json");
  const htmlPath = path.join(outputDir, "evaluation.html");
  await atomicWrite(jsonPath, JSON.stringify(result, null, 2) + "\n");
  await atomicWrite(htmlPath, renderEvaluationHtml(result));
  return { jsonPath, htmlPath };
}

async function main(): Promise<void> {
  const manifestArg = readArg("--manifest") ?? defaultManifest;
  const outputArg = readArg("--out") ?? defaultOutput;
  const result = await runEvaluation(path.resolve(manifestArg));
  const paths = await writeEvaluationReports(result, path.resolve(outputArg));
  const baseline = result.experiments.find((experiment) => experiment.id === result.baselineExperiment)!;
  process.stdout.write(
    `Evaluation ${result.thresholdStatus}: ${result.baselineExperiment} hit=${format(baseline.metrics.hitRate)} recall=${format(baseline.metrics.recall)} mrr=${format(baseline.metrics.mrr)} ndcg=${format(baseline.metrics.ndcg)}\n`,
  );
  process.stdout.write(`JSON: ${paths.jsonPath}\nHTML: ${paths.htmlPath}\n`);
  if (result.thresholdStatus === "fail") process.exitCode = 1;
}

function validateManifest(manifest: EvalManifest): void {
  if (manifest.version !== 1) throw new Error("Evaluation manifest version must be 1.");
  if (manifest.backend !== "lexical-tfidf-cosine-v1") throw new Error("Unsupported evaluation backend.");
  if (!Number.isInteger(manifest.topK) || manifest.topK < 1) throw new Error("topK must be a positive integer.");
  if (!Array.isArray(manifest.experiments) || manifest.experiments.length === 0) {
    throw new Error("Evaluation manifest requires experiments.");
  }
}

async function atomicWrite(target: string, contents: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(temporary, contents);
  await fsp.rename(temporary, target);
}

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function format(value: number): string {
  return value.toFixed(3);
}

function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
