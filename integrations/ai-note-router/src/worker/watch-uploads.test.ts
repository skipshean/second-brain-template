import test from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicUploadId, determineUploadSuccess } from "./watch-uploads.js";

test("marks upload successful when Linear is not configured", () => {
  const success = determineUploadSuccess({
    hasProject: true,
    hasPeople: true,
    linearAction: "skip",
    linearReason: "Skipping Linear write because LINEAR_API_KEY is not set.",
  });
  assert.equal(success, true);
});

test("builds stable upload IDs for same source input", () => {
  const body = "meeting title: Weekly Sync\nnotes";
  const a = buildDeterministicUploadId("fireflies", "meeting.txt", body);
  const b = buildDeterministicUploadId("fireflies", "meeting.txt", body);
  const c = buildDeterministicUploadId("fireflies", "meeting.txt", `${body}\nmore`);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
