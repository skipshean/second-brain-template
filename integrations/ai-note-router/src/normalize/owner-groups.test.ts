import test from "node:test";
import assert from "node:assert/strict";
import { classifyOwnerGroup } from "./owner-groups.js";

const baseExtractor = {
  max_items: 15,
  curated_mode: "prefer" as const,
  commitment_phrases: ["i'll"],
  owner_groups: {
    self: ["Alex", "Alex Morgan"],
    client: ["Casey", "Casey Client"],
    parking_lot_markers: ["parking lot", "open question", "maybe"],
  },
};

test("self when assignee matches owner_groups.self", () => {
  const g = classifyOwnerGroup(
    { title: "Draft contract", confidence: 1, assigneeName: "Alex" },
    baseExtractor
  );
  assert.equal(g, "self");
});

test("client when assignee matches owner_groups.client", () => {
  const g = classifyOwnerGroup(
    { title: "Send photos", confidence: 1, assigneeName: "Casey" },
    baseExtractor
  );
  assert.equal(g, "client");
});

test("client as default bucket for unknown non-self assignee", () => {
  const g = classifyOwnerGroup(
    { title: "Send invoice", confidence: 1, assigneeName: "Mystery Partner" },
    baseExtractor
  );
  assert.equal(g, "client");
});

test("parking_lot when title contains a parking lot marker", () => {
  const g = classifyOwnerGroup(
    { title: "Maybe we add live chat someday", confidence: 1, assigneeName: "Alex" },
    baseExtractor
  );
  assert.equal(g, "parking_lot");
});

test("parking_lot when no assignee", () => {
  const g = classifyOwnerGroup(
    { title: "Review site analytics", confidence: 1 },
    baseExtractor
  );
  assert.equal(g, "parking_lot");
});

test("self when the note-taker (Microphone) speaks a commitment with no assignee", () => {
  const g = classifyOwnerGroup(
    { title: "send the deck by Friday", confidence: 0.5, sourceSpeaker: "Microphone" },
    baseExtractor
  );
  assert.equal(g, "self");
});

test("explicit non-self assignee wins over a Microphone speaker", () => {
  const g = classifyOwnerGroup(
    { title: "send photos", confidence: 0.5, assigneeName: "Casey", sourceSpeaker: "Microphone" },
    baseExtractor
  );
  assert.equal(g, "client");
});

test("non-self speaker with no assignee stays parking_lot", () => {
  const g = classifyOwnerGroup(
    { title: "review the analytics", confidence: 0.5, sourceSpeaker: "Speaker" },
    baseExtractor
  );
  assert.equal(g, "parking_lot");
});
