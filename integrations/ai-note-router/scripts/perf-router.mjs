#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { performance } from "perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");

const { loadRouterConfig } = await import("../dist/config/load.js");
const { resolveRouting } = await import("../dist/resolve/routing.js");
const { firefliesAdapter } = await import("../dist/sources/fireflies.js");

const configPath = join(repoRoot, "integrations/ai-note-router/config/authority.yaml");
const config = loadRouterConfig(configPath);

const indexPath = join(repoRoot, "integrations/linear-vault-sync/router-index/index.json");
const indexExists = (() => {
  try {
    JSON.parse(readFileSync(indexPath, "utf8"));
    return true;
  } catch {
    return false;
  }
})();

const sampleInput = {
  source: "fireflies",
  id: "bench-2026-03-20T00:00:00Z",
  url: "upload://bench",
  title: "Transcript",
  body: "meeting title: Acme Analytics\nmeeting participants: Alex, Riley\ntranscript:\nDiscuss roadmap and rollout.",
  project: "Acme Analytics",
};

const warmupIterations = 200;
const iterations = 5000;

for (let i = 0; i < warmupIterations; i += 1) {
  const note = firefliesAdapter.load(sampleInput);
  resolveRouting(note, config, repoRoot);
}

const started = performance.now();
for (let i = 0; i < iterations; i += 1) {
  const note = firefliesAdapter.load(sampleInput);
  resolveRouting(note, config, repoRoot);
}
const elapsedMs = performance.now() - started;

const avgMs = elapsedMs / iterations;
const throughput = iterations / (elapsedMs / 1000);

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const outDir = join(repoRoot, "outputs/ai-note-router/perf");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `${stamp}-router-benchmark.md`);

const report = [
  "# AI Note Router Performance Benchmark",
  "",
  `- Timestamp: ${now.toISOString()}`,
  `- Config path: ${configPath}`,
  `- Linear index available: ${indexExists ? "yes" : "no"}`,
  `- Warmup iterations: ${warmupIterations}`,
  `- Timed iterations: ${iterations}`,
  "",
  "## Results",
  "",
  `- Total time: ${elapsedMs.toFixed(2)} ms`,
  `- Average per iteration: ${avgMs.toFixed(4)} ms`,
  `- Throughput: ${throughput.toFixed(2)} iterations/sec`,
  "",
].join("\n");

writeFileSync(outPath, report, "utf8");
console.log(report);
console.log(`Report written to ${outPath}`);
