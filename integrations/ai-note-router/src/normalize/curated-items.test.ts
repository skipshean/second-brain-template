import test from "node:test";
import assert from "node:assert/strict";
import { extractCuratedActions } from "./curated-items.js";

test("returns null when no curated section is present (pure transcript)", () => {
  const body = [
    "Casey Client: Hello.",
    "Alex Morgan: How you doing?",
    "Casey Client: Excellent.",
  ].join("\n");
  assert.equal(extractCuratedActions(body), null);
});

test("parses Fireflies-style 'Action Items:' block with inline owner", () => {
  const body = [
    "Overview",
    "Some summary text.",
    "",
    "Action Items:",
    "Sam: send revised budget",
    "Follow up with legal on MSA",
    "",
    "Transcript",
    "Sam: hi",
  ].join("\n");
  const out = extractCuratedActions(body);
  assert.ok(out);
  assert.equal(out!.length, 2);
  assert.equal(out![0]!.title, "send revised budget");
  assert.equal(out![0]!.assigneeName, "Sam");
  assert.equal(out![1]!.title, "Follow up with legal on MSA");
  assert.equal(out![1]!.assigneeName, undefined);
});

test("parses Granola-style '### Next Steps' with owner subsections", () => {
  const body = [
    "### Brand & Visual Direction",
    "- Some note",
    "",
    "### Next Steps",
    "",
    "- Casey (Cclient)",
    "",
    "  - Send inspiration links",
    "  - Send list of bar memberships",
    "",
    "- Alex",
    "",
    "  - Draft content direction",
    "  - Send contractor agreement",
    "",
    "---",
    "",
    "Transcript",
    "microphone: Hello!",
  ].join("\n");
  const out = extractCuratedActions(body);
  assert.ok(out);
  assert.equal(out!.length, 4);
  assert.equal(out![0]!.assigneeName, "Casey");
  assert.equal(out![0]!.ownerHeading, "Casey (Cclient)");
  assert.equal(out![0]!.title, "Send inspiration links");
  assert.equal(out![2]!.assigneeName, "Alex");
  assert.equal(out![2]!.title, "Draft content direction");
});

test("joins wrapped continuation lines into one item", () => {
  const body = [
    "### Next Steps",
    "- Alex",
    "  - Draft content direction",
    "    that covers both menu pages",
    "    and the SEO layer",
    "  - Send contractor agreement",
  ].join("\n");
  const out = extractCuratedActions(body);
  assert.ok(out);
  assert.equal(out!.length, 2);
  assert.match(out![0]!.title, /Draft content direction that covers both menu pages and the SEO layer/);
});

test("stops at a following heading of equal or higher level", () => {
  const body = [
    "### Next Steps",
    "- Alex",
    "  - Draft first pass",
    "### Decisions",
    "- Brand is black/silver.",
  ].join("\n");
  const out = extractCuratedActions(body);
  assert.ok(out);
  assert.equal(out!.length, 1);
  assert.equal(out![0]!.title, "Draft first pass");
});

test("empty curated section returns [] not null", () => {
  const body = "### Next Steps\n\n---\nTranscript\n";
  const out = extractCuratedActions(body);
  assert.deepEqual(out, []);
});
