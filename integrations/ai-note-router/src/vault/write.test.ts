import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { writeVaultNote } from "./write.js";

test("writing an unchanged vault note is a no-op", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-write-test-"));
  const note = { filePath: "outputs/ai-note-router/sample.md", updated: false, summary: "# Sample\n\nbody\n" };
  const first = writeVaultNote(workspaceRoot, note);
  utimesSync(first.filePath, new Date(0), new Date(0));
  const second = writeVaultNote(workspaceRoot, note);
  assert.equal(second.filePath, first.filePath);
  assert.equal(statSync(second.filePath).mtimeMs, 0);
});
