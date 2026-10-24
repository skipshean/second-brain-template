import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadRouterConfig } from "./load.js";

test("parses sibling source sections under sources", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-router-load-test-"));
  const configPath = join(dir, "authority.yaml");
  writeFileSync(
    configPath,
    [
      "default_authority: fireflies",
      "sources:",
      "  fireflies:",
      "    enabled: true",
      "    connected: false",
      "  granola:",
      "    enabled: true",
      "    connected: true",
      "  obsidian:",
      "    enabled: false",
      "",
    ].join("\n"),
    "utf8"
  );

  const parsed = loadRouterConfig(configPath);
  assert.equal(parsed.sources.fireflies.connected, false);
  assert.equal(parsed.sources.granola.connected, true);
  assert.equal(parsed.sources.obsidian.enabled, false);
});

test("parses quoted scalar values and null routing defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-router-load-test-"));
  const configPath = join(dir, "authority.yaml");
  writeFileSync(
    configPath,
    [
      "default_authority: 'granola'",
      "routing:",
      "  default_team: \"Team Alpha\"",
      "  default_project: \"~\"",
      "dedupe:",
      "  search_scope: \"all_linear_issues\"",
      "  canonical_strategy: 'newest_open_issue'",
      "",
    ].join("\n"),
    "utf8"
  );

  const parsed = loadRouterConfig(configPath);
  assert.equal(parsed.default_authority, "granola");
  assert.equal(parsed.routing.default_team, "Team Alpha");
  assert.equal(parsed.routing.default_project, null);
  assert.equal(parsed.dedupe.search_scope, "all_linear_issues");
  assert.equal(parsed.dedupe.canonical_strategy, "newest_open_issue");
});

test("throws on invalid boolean values", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-router-load-test-"));
  const configPath = join(dir, "authority.yaml");
  writeFileSync(
    configPath,
    ["default_authority: fireflies", "routing:", "  infer_team_from_project: maybe", ""].join("\n"),
    "utf8"
  );

  assert.throws(() => loadRouterConfig(configPath), /Invalid boolean/);
});

test("extractor defaults when omitted from YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cfg-"));
  const p = join(dir, "a.yaml");
  writeFileSync(p, "default_authority: fireflies\n", "utf8");
  const cfg = loadRouterConfig(p);
  assert.equal(cfg.extractor.max_items, 15);
  assert.equal(cfg.extractor.curated_mode, "prefer");
  assert.ok(cfg.extractor.commitment_phrases.length > 0);
  assert.deepEqual(cfg.extractor.owner_groups.self, []);
});

test("extractor overrides from YAML", () => {
  const dir = mkdtempSync(join(tmpdir(), "router-cfg-"));
  const p = join(dir, "b.yaml");
  writeFileSync(
    p,
    [
      "default_authority: fireflies",
      "extractor:",
      "  max_items: 8",
      "  curated_mode: force",
      "  commitment_phrases:",
      "    - \"i'll\"",
      "    - \"send me\"",
      "  owner_groups:",
      "    self: [Alex]",
      "    client: [Casey, Casey Client]",
      "    parking_lot_markers: [parking lot, open question]",
      "",
    ].join("\n"),
    "utf8"
  );
  const cfg = loadRouterConfig(p);
  assert.equal(cfg.extractor.max_items, 8);
  assert.equal(cfg.extractor.curated_mode, "force");
  assert.deepEqual(cfg.extractor.commitment_phrases, ["i'll", "send me"]);
  assert.deepEqual(cfg.extractor.owner_groups.client, ["Casey", "Casey Client"]);
});
