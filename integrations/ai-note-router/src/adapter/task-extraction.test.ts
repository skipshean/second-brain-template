import test from "node:test";
import assert from "node:assert/strict";
import { extractTasksFromFirefliesTranscript } from "./task-extraction.js";

test("extracts tasks from Fireflies summary action_items", () => {
  const tasks = extractTasksFromFirefliesTranscript({
    summary: {
      action_items: "Sam: send revised budget\nFollow up with legal on MSA",
    },
    sentences: [],
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.title, "send revised budget");
  assert.equal(tasks[0]?.assigneeName, "Sam");
  assert.equal(tasks[1]?.title, "Follow up with legal on MSA");
});

test("extracts task candidates from sentence ai_filters", () => {
  const tasks = extractTasksFromFirefliesTranscript({
    summary: null,
    sentences: [
      {
        speaker_name: "Alex",
        text: "I will send the dashboard mock by Friday.",
        ai_filters: { task: true },
      },
      {
        speaker_name: "Jamie",
        text: "This is not a task.",
        ai_filters: { task: false },
      },
    ],
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "I will send the dashboard mock by Friday.");
  assert.equal(tasks[0]?.assigneeName, "Alex");
  assert.equal(tasks[0]?.sourceSpeaker, "Alex");
});

test("source-of-truth mode: summary.action_items wins over ai_filters sentences", () => {
  const tasks = extractTasksFromFirefliesTranscript({
    summary: { action_items: "Alex: send contractor agreement" },
    sentences: [
      { speaker_name: "Alex", text: "I will also do something random.", ai_filters: { task: true } },
    ],
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "send contractor agreement");
});
