import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkpointJob,
  JobSpec,
  jobManifestPathFor,
  loadOrCreateJob,
  removeJob,
} from "../src/job-state.js";

let tmp: string;

const ids = ["1111111111111111", "2222222222222222", "3333333333333333"];

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "auto-embed-job-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

function spec(): JobSpec {
  return {
    sourcePath: path.join(tmp, "doc.md"),
    sourceHash: "a".repeat(64),
    planHash: "b".repeat(64),
    embeddingProvider: "openai",
    embeddingModel: "fake-model",
    dimensions: 4,
    collection: "docs",
    vectorDb: "chroma",
    targetChunkIds: ids,
    removedChunkIds: ["ffffffffffffffff"],
  };
}

describe("durable job state", () => {
  it("derives a deterministic path and atomically creates the initial manifest", async () => {
    const input = spec();
    const firstPath = jobManifestPathFor(input, tmp);
    const secondPath = jobManifestPathFor({ ...input }, tmp);
    expect(firstPath).toBe(secondPath);
    expect(firstPath).toMatch(/\.auto-embed\/jobs\/[a-f0-9]{64}\.job\.json$/);

    const manifest = await loadOrCreateJob(input, { baseDir: tmp });
    expect(manifest.completedChunkIds).toEqual([]);
    expect(JSON.parse(await fsp.readFile(firstPath, "utf8"))).toEqual(manifest);
  });

  it("checkpoints completed IDs in target order and resumes them", async () => {
    const input = spec();
    const initial = await loadOrCreateJob(input, { baseDir: tmp });
    const updated = await checkpointJob(initial, [ids[2]!, ids[0]!], { baseDir: tmp });
    expect(updated.completedChunkIds).toEqual([ids[0], ids[2]]);

    const resumed = await loadOrCreateJob(input, { baseDir: tmp });
    expect(resumed.completedChunkIds).toEqual([ids[0], ids[2]]);
  });

  it("rejects checkpoint IDs that are not part of the target job", async () => {
    const initial = await loadOrCreateJob(spec(), { baseDir: tmp });
    await expect(
      checkpointJob(initial, ["eeeeeeeeeeeeeeee"], { baseDir: tmp }),
    ).rejects.toThrow(/not part of job/i);
  });

  it("resets prior progress for --force and removes state after completion", async () => {
    const input = spec();
    const initial = await loadOrCreateJob(input, { baseDir: tmp });
    await checkpointJob(initial, [ids[0]!], { baseDir: tmp });

    const reset = await loadOrCreateJob(input, { baseDir: tmp, reset: true });
    expect(reset.completedChunkIds).toEqual([]);

    await removeJob(reset, { baseDir: tmp });
    await expect(fsp.stat(jobManifestPathFor(input, tmp))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
