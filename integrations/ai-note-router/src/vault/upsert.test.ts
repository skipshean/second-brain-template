import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CanonicalNote } from "../normalize/note.js";
import type { ResolvedRoute } from "../resolve/routing.js";
import { upsertProjectNote, buildTasksSection } from "./upsert.js";

function meetingNote(overrides: Partial<CanonicalNote> = {}): CanonicalNote {
  return {
    source: {
      source: "fireflies",
      url: "upload://meeting",
      externalId: "m-1",
      capturedAt: "2026-03-20T12:00:00Z",
    },
    title: "Transcript",
    body: "meeting title: Weekly Growth Sync\ntranscript:\nDiscussed roadmap.",
    people: [{ name: "Alex" }],
    tasks: [],
    confidence: 1,
    tags: ["meetings"],
    authority: { source: "fireflies" },
    ...overrides,
  };
}

const baseRoute: ResolvedRoute = {
  team: "Team A",
  project: "Canonical Project",
  reason: "test route",
};

test("uses meeting title from body for meeting filename/title", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const result = upsertProjectNote(workspaceRoot, meetingNote(), baseRoute);
  assert.match(result.filePath, /meetings\/weekly-growth-sync\.md$/);
  const content = readFileSync(result.filePath, "utf8");
  assert.match(content, /^# Weekly Growth Sync$/m);
});

test("indexes meeting under canonical project route and avoids synthetic project path", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const note = meetingNote({
    project: "Weekly Growth Sync 2026-03-20 Meeting",
  });
  const result = upsertProjectNote(workspaceRoot, note, baseRoute);
  assert.ok(result.projectFilePath, "expected project index path");
  assert.match(result.projectFilePath ?? "", /projects\/canonical-project\.md$/);
  const projectContent = readFileSync(result.projectFilePath!, "utf8");
  assert.match(projectContent, /\[\[meetings\/weekly-growth-sync\|Weekly Growth Sync\]\]/);
});

test("preserves manual tasks while appending new extracted tasks", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const first = upsertProjectNote(
    workspaceRoot,
    meetingNote({
      tasks: [{ title: "Send deck", confidence: 0.9 }],
    }),
    baseRoute
  );

  writeFileSync(
    first.filePath,
    readFileSync(first.filePath, "utf8").replace("- [ ] Send deck", "- [x] Send deck"),
    "utf8"
  );

  upsertProjectNote(
    workspaceRoot,
    meetingNote({
      tasks: [{ title: "Follow up with legal", confidence: 0.9 }],
    }),
    baseRoute
  );

  const content = readFileSync(first.filePath, "utf8");
  assert.match(content, /- \[x\] Send deck/);
  assert.match(content, /- \[ \] Follow up with legal/);
});

test("re-ingesting a grouped meeting keeps subheaders and preserves completed tasks", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const groupedTasks = [
    { title: "Send contract", confidence: 1, assigneeName: "Alex", ownerGroup: "self" as const },
    { title: "Send photos", confidence: 1, assigneeName: "Casey", ownerGroup: "client" as const },
    { title: "Maybe live chat", confidence: 1, ownerGroup: "parking_lot" as const },
  ];

  const first = upsertProjectNote(
    workspaceRoot,
    meetingNote({ tasks: groupedTasks }),
    baseRoute
  );

  // Mark one of the self-group items as completed by hand.
  writeFileSync(
    first.filePath,
    readFileSync(first.filePath, "utf8").replace("- [ ] Send contract", "- [x] Send contract"),
    "utf8"
  );

  // Re-ingest the same meeting — extractor returns the same grouped tasks.
  upsertProjectNote(
    workspaceRoot,
    meetingNote({ tasks: groupedTasks }),
    baseRoute
  );

  const content = readFileSync(first.filePath, "utf8");
  assert.match(content, /### Mine/, "Mine subheader should survive re-ingest");
  assert.match(content, /### Client/, "Client subheader should survive re-ingest");
  assert.match(content, /### Open Questions \/ Parking Lot/, "Parking Lot subheader should survive re-ingest");
  assert.match(content, /- \[x\] Send contract/, "manually-completed task should be preserved");
  assert.doesNotMatch(
    content,
    /- \[ \] Send contract/,
    "should not have an unchecked duplicate of the completed task"
  );
});

test("re-ingesting after extractor drops a completed task appends it to Completed", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const first = upsertProjectNote(
    workspaceRoot,
    meetingNote({
      tasks: [
        { title: "Send contract", confidence: 1, assigneeName: "Alex", ownerGroup: "self" },
        { title: "Send photos", confidence: 1, assigneeName: "Casey", ownerGroup: "client" },
      ],
    }),
    baseRoute
  );

  writeFileSync(
    first.filePath,
    readFileSync(first.filePath, "utf8").replace("- [ ] Send contract", "- [x] Send contract"),
    "utf8"
  );

  // Second ingest no longer surfaces "Send contract" from the extractor.
  upsertProjectNote(
    workspaceRoot,
    meetingNote({
      tasks: [
        { title: "Send photos", confidence: 1, assigneeName: "Casey", ownerGroup: "client" },
      ],
    }),
    baseRoute
  );

  const content = readFileSync(first.filePath, "utf8");
  assert.match(content, /### Completed\n- \[x\] Send contract/);
  assert.match(content, /### Client\n- \[ \] Send photos/);
});

test("truncates managed summary when note body exceeds cap", () => {
  const previous = process.env.ROUTER_MANAGED_SUMMARY_MAX_CHARS;
  process.env.ROUTER_MANAGED_SUMMARY_MAX_CHARS = "600";
  try {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
    const longBody = `meeting title: Long Summary Test\ntranscript:\n${"A".repeat(2000)}`;
    const result = upsertProjectNote(
      workspaceRoot,
      meetingNote({
        body: longBody,
      }),
      baseRoute
    );
    const content = readFileSync(result.filePath, "utf8");
    assert.match(content, /\[truncated \d+ chars\]/);
  } finally {
    if (previous === undefined) delete process.env.ROUTER_MANAGED_SUMMARY_MAX_CHARS;
    else process.env.ROUTER_MANAGED_SUMMARY_MAX_CHARS = previous;
  }
});

test("buildTasksSection groups tasks by ownerGroup when present", () => {
  const note: CanonicalNote = {
    source: { source: "fireflies", url: "x" },
    title: "t",
    body: "b",
    people: [],
    tasks: [
      { title: "Send contract", confidence: 1, assigneeName: "Alex", ownerGroup: "self" },
      { title: "Send photos", confidence: 1, assigneeName: "Casey", ownerGroup: "client" },
      { title: "Draft style guide", confidence: 1, assigneeName: "Alex", ownerGroup: "self" },
      { title: "Maybe live chat", confidence: 1, ownerGroup: "parking_lot" },
    ],
    confidence: 1,
    tags: [],
    authority: { source: "fireflies" },
  };
  const out = buildTasksSection(note);
  assert.match(out, /^## Tasks\n/);
  assert.match(out, /### Mine\n- \[ \] Send contract.*\n- \[ \] Draft style guide/);
  assert.match(out, /### Client\n- \[ \] Send photos/);
  assert.match(out, /### Open Questions \/ Parking Lot\n- \[ \] Maybe live chat/);
});

test("buildTasksSection stays flat when no ownerGroup is set", () => {
  const note: CanonicalNote = {
    source: { source: "fireflies", url: "x" },
    title: "t",
    body: "b",
    people: [],
    tasks: [{ title: "Send contract", confidence: 1, assigneeName: "Alex" }],
    confidence: 1,
    tags: [],
    authority: { source: "fireflies" },
  };
  const out = buildTasksSection(note);
  assert.doesNotMatch(out, /### /);
  assert.match(out, /- \[ \] Send contract.*owner: Alex/);
});

test("re-ingesting an unchanged meeting does not rewrite the note", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-upsert-test-"));
  const first = upsertProjectNote(workspaceRoot, meetingNote(), baseRoute);
  const before = readFileSync(first.filePath, "utf8");
  const mtimeBefore = statSync(first.filePath).mtimeMs;
  utimesSync(first.filePath, new Date(0), new Date(0));
  const second = upsertProjectNote(workspaceRoot, meetingNote(), baseRoute);
  assert.equal(second.updated, false);
  assert.equal(readFileSync(second.filePath, "utf8"), before);
  assert.equal(statSync(second.filePath).mtimeMs, 0, "file must not be touched when content is unchanged");
  assert.ok(mtimeBefore > 0);
});
