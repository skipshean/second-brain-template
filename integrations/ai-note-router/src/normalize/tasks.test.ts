import test from "node:test";
import assert from "node:assert/strict";
import { buildTaskCandidates } from "./tasks.js";

test("infers tasks from transcript lines and maps assignee to participants", () => {
  const tasks = buildTaskCandidates({
    body: [
      "Action items:",
      "- Sam: send revised deck by Friday",
      "- Follow up with legal on MSA",
    ].join("\n"),
    people: [
      { name: "Sam Taylor", email: "sam@example.com" },
      { name: "Jamie Smith" },
    ],
    tasks: [],
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.assigneeName, "Sam Taylor");
  assert.equal(tasks[0]?.assigneeEmail, "sam@example.com");
  assert.equal(tasks[1]?.assigneeName, undefined);
});

test("keeps provided tasks and enriches assignee identity from participants", () => {
  const tasks = buildTaskCandidates({
    body: "No explicit tasks in transcript",
    people: [{ name: "Alex Kim", email: "alex@company.com" }],
    tasks: [{ title: "Send kickoff email", confidence: 0.9, assigneeName: "Alex" }],
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.assigneeName, "Alex Kim");
  assert.equal(tasks[0]?.assigneeEmail, "alex@company.com");
});

test("extracts due date from explicit ISO date in title", () => {
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Send invoice by 2026-04-01",
    people: [],
    tasks: [],
    capturedAt: "2026-03-19T10:00:00Z",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-04-01");
});

test("extracts due date from weekday phrase using captured date context", () => {
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Sam: send revised deck by Friday",
    people: [{ name: "Sam Taylor" }],
    tasks: [],
    capturedAt: "2026-03-19T10:00:00Z",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-03-20");
});

test("extracts due date from by tomorrow (UTC calendar)", () => {
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Ship deck by tomorrow",
    people: [],
    tasks: [],
    capturedAt: "2026-03-19T10:00:00Z",
    timeZone: "UTC",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-03-20");
});

test("extracts EOW as Friday on or after reference day (UTC)", () => {
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Legal review EOW",
    people: [],
    tasks: [],
    capturedAt: "2026-03-18T12:00:00Z",
    timeZone: "UTC",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-03-20");
});

test("extracts next week as Monday of the following ISO week (UTC)", () => {
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Kickoff recap next week",
    people: [],
    tasks: [],
    capturedAt: "2026-03-19T10:00:00Z",
    timeZone: "UTC",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-03-23");
});

test("tomorrow respects IANA time zone when Temporal is available", (t) => {
  if (!(globalThis as { Temporal?: unknown }).Temporal) {
    t.skip();
    return;
  }
  const tasks = buildTaskCandidates({
    body: "Action items:\n- Send packet by tomorrow",
    people: [],
    tasks: [],
    capturedAt: "2026-03-20T03:00:00Z",
    timeZone: "America/New_York",
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.dueDate, "2026-03-20");
});

test("does not turn every speaker transcript line into tasks", () => {
  const tasks = buildTaskCandidates({
    body: [
      "Transcript",
      "Alex: Hey Pat, good to see you.",
      "Pat: Good to see you too.",
      "Alex: I'll send you my resume tonight.",
      "Pat: Great, once I have it I'll get process rolling.",
    ].join("\n"),
    people: [{ name: "Alex" }, { name: "Pat" }],
    tasks: [],
  });

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.title, "I'll send you my resume tonight.");
  assert.equal(tasks[1]?.title, "Great, once I have it I'll get process rolling.");
});

test("heuristic ignores generic 'X should' speculation", () => {
  const tasks = buildTaskCandidates({
    body: "Alex should send Pat his resume to get the job process rolling.",
    people: [{ name: "Alex Morgan" }, { name: "Pat Lee" }],
    tasks: [],
  });
  // No commitment phrase, no date ref, no curated section → empty under tightened heuristic.
  assert.equal(tasks.length, 0);
});

test("caps heuristic output at extractor.max_items", () => {
  const lines: string[] = ["Transcript"];
  for (let i = 0; i < 30; i += 1) {
    lines.push(`Alex: I'll do item ${i} by tomorrow.`);
  }
  const tasks = buildTaskCandidates({
    body: lines.join("\n"),
    people: [{ name: "Alex" }],
    tasks: [],
    extractor: {
      max_items: 7,
      curated_mode: "prefer",
      commitment_phrases: ["i'll"],
      owner_groups: { self: [], client: [], parking_lot_markers: [] },
    },
  });
  assert.equal(tasks.length, 7);
});

test("curated section is not capped by max_items", () => {
  const lines = ["Action Items:"];
  for (let i = 0; i < 30; i += 1) lines.push(`- Alex: item ${i}`);
  const tasks = buildTaskCandidates({
    body: lines.join("\n"),
    people: [{ name: "Alex" }],
    tasks: [],
    extractor: {
      max_items: 5,
      curated_mode: "prefer",
      commitment_phrases: [],
      owner_groups: { self: [], client: [], parking_lot_markers: [] },
    },
  });
  assert.equal(tasks.length, 30);
});

test("curated_mode: 'force' returns [] when no curated section is present", () => {
  const tasks = buildTaskCandidates({
    body: "Alex: I'll draft the deck by tomorrow.\nCasey: I'll send photos.",
    people: [{ name: "Alex" }, { name: "Casey" }],
    tasks: [],
    extractor: {
      max_items: 15,
      curated_mode: "force",
      commitment_phrases: ["i'll"],
      owner_groups: { self: [], client: [], parking_lot_markers: [] },
    },
  });
  assert.equal(tasks.length, 0);
});

test("curated bullets survive the chatter filter (trusted source)", () => {
  // "Does this make sense?" trips isLikelyConversationLine (trailing ?) in the
  // heuristic path. Because it came from a curated "Action Items:" block, the
  // chatter filter is skipped and the bullet is preserved.
  const tasks = buildTaskCandidates({
    body: "Action Items:\n- Does this make sense to everyone?",
    people: [],
    tasks: [],
  });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.title, "Does this make sense to everyone?");
});
