import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
const baseline = process.argv[2];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sarion-bench-"));
const state = path.join(tmp, "state"),
  repo = path.join(tmp, "repo");
fs.mkdirSync(state, { mode: 0o700 });
fs.mkdirSync(repo);
for (let i = 0; i < 200; i++)
  fs.writeFileSync(
    path.join(repo, "file-" + i + ".txt"),
    "representative source\n".repeat(100),
  );
const measure = (entry, args) => {
  const samples = [];
  for (let i = 0; i < 21; i++) {
    const t = performance.now();
    const p = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env, SARION_V2_HOME: state },
      cwd: repo,
      encoding: "utf8",
      timeout: 15000,
    });
    if (p.status !== 0) throw Error(p.stderr);
    if (i) samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    medianMs: +samples[10].toFixed(2),
    p95Ms: +samples[18].toFixed(2),
  };
};
try {
  const result = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    fixture: { files: 200, bytes: 420000 },
    evidence: "warm local processes; no inference or network",
    versions: {},
  };
  for (const [name, entry] of [
    ["candidate", path.resolve("bin/sarion.mjs")],
    ...(baseline ? [["baseline", path.resolve(baseline)]] : []),
  ]) {
    result.versions[name] = {
      startup: measure(entry, ["--version"]),
      discovery: measure(entry, ["project", "files"]),
    };
  }
  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/performance.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
