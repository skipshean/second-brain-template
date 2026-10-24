import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadKnownFingerprints, isKnownIngest } from "./ingest-dedupe.js";
import { saveProcessedState } from "./processed.js";

function setup(): { statePath: string; inboxDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ingest-dedupe-"));
  const inboxDir = join(dir, "inbox");
  mkdirSync(inboxDir);
  return { statePath: join(dir, "state.json"), inboxDir };
}

test("treats processed and skipped fingerprints as known", () => {
  const { statePath, inboxDir } = setup();
  saveProcessedState(statePath, {
    processedFingerprints: ["fireflies:done"],
    skippedFingerprints: [{ fingerprint: "granola:retired", reason: "retired", skippedAt: "2026-10-17T00:00:00.000Z" }],
  });
  const known = loadKnownFingerprints({ statePath, inboxDir });
  assert.equal(isKnownIngest(known, "fireflies", "done"), true);
  assert.equal(isKnownIngest(known, "granola", "retired"), true);
  assert.equal(isKnownIngest(known, "fireflies", "fresh"), false);
});

test("treats a payload already waiting in the inbox as known", () => {
  const { statePath, inboxDir } = setup();
  writeFileSync(join(inboxDir, "2026-10-17T15-00-00-000Z-fireflies-01ABC.json"), "{}", "utf8");
  writeFileSync(join(inboxDir, "notes.txt"), "ignore me", "utf8");
  const known = loadKnownFingerprints({ statePath, inboxDir });
  assert.equal(isKnownIngest(known, "fireflies", "01ABC"), true);
  assert.equal(isKnownIngest(known, "granola", "01ABC"), false);
});

test("handles a missing state file and missing inbox", () => {
  const dir = mkdtempSync(join(tmpdir(), "ingest-dedupe-"));
  const known = loadKnownFingerprints({ statePath: join(dir, "none.json"), inboxDir: join(dir, "nope") });
  assert.equal(known.size, 0);
});
