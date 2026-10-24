import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadProcessedState, saveProcessedState } from "./processed.js";

test("round-trips skipped fingerprints alongside processed ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "processed-state-"));
  const statePath = join(dir, "state.json");
  saveProcessedState(statePath, {
    processedFingerprints: ["fireflies:a"],
    skippedFingerprints: [{ fingerprint: "granola:b", reason: "Entity is retired: team", skippedAt: "2026-10-17T00:00:00.000Z" }],
  });
  const loaded = loadProcessedState(statePath);
  assert.deepEqual(loaded.processedFingerprints, ["fireflies:a"]);
  assert.deepEqual(loaded.skippedFingerprints, [
    { fingerprint: "granola:b", reason: "Entity is retired: team", skippedAt: "2026-10-17T00:00:00.000Z" },
  ]);
});

test("loads a legacy state file that has no skipped list", () => {
  const dir = mkdtempSync(join(tmpdir(), "processed-state-"));
  const statePath = join(dir, "state.json");
  writeFileSync(statePath, JSON.stringify({ processedFingerprints: ["fireflies:a"] }), "utf8");
  const loaded = loadProcessedState(statePath);
  assert.deepEqual(loaded.processedFingerprints, ["fireflies:a"]);
  assert.deepEqual(loaded.skippedFingerprints, []);
});
