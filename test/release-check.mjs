import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist", "index.js");
const tmp = await mkdtemp(path.join(os.tmpdir(), "auto-embed-release-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function spawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

try {
  const starts = [];
  for (let index = 0; index < 3; index++) {
    const started = performance.now();
    const result = spawn(process.execPath, [cli, "--help"]);
    starts.push(performance.now() - started);
    assert.match(result.stdout, /Zero-config CLI/);
  }
  const maxColdStartMs = Math.max(...starts);
  assert.ok(
    maxColdStartMs < 500,
    `cold start ${maxColdStartMs.toFixed(1)} ms exceeded 500 ms budget`,
  );

  const packed = spawn(
    npm,
    ["pack", "--json", "--pack-destination", tmp],
    { shell: process.platform === "win32" },
  );
  const packInfo = JSON.parse(packed.stdout)[0];
  assert.ok(packInfo, "npm pack did not return package metadata");
  assert.ok(
    packInfo.unpackedSize < 30 * 1024 * 1024,
    `unpacked package ${(packInfo.unpackedSize / 1024 / 1024).toFixed(2)} MB exceeded 30 MB`,
  );
  const filenames = new Set(packInfo.files.map((file) => file.path));
  for (const required of ["README.md", "LICENSE", "dist/index.js", "package.json"]) {
    assert.ok(filenames.has(required), `packed artifact is missing ${required}`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: "ok",
        maxColdStartMs: Number(maxColdStartMs.toFixed(1)),
        packedBytes: packInfo.size,
        unpackedBytes: packInfo.unpackedSize,
        files: packInfo.entryCount,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
