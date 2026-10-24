import test from "node:test";
import assert from "node:assert/strict";
import { firefliesAdapter } from "./fireflies.js";

test("does not infer synthetic project from meeting title", () => {
  const note = firefliesAdapter.load({
    source: "fireflies",
    id: "2026-03-19T12:00:00Z-upload",
    url: "upload://sample",
    title: "Transcript",
    body: "meeting title: Acme Analytics\nmeeting participants: Alex",
  });

  assert.equal(note.project, undefined);
});

test("preserves explicit project from source input", () => {
  const note = firefliesAdapter.load({
    source: "fireflies",
    id: "abc",
    url: "upload://sample",
    title: "Transcript",
    body: "meeting title: Acme Analytics",
    project: "Acme Analytics",
  });

  assert.equal(note.project, "Acme Analytics");
});
