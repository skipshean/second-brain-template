import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { CanonicalNote } from "../normalize/note.js";
import type { RouterConfig } from "../config/types.js";
import { resolveRouting } from "./routing.js";

function baseConfig(): RouterConfig {
  return {
    default_authority: "fireflies",
    authority_overrides: { projects: {}, clients: {} },
    routing: {
      infer_team_from_project: true,
      infer_project_from_client: true,
      default_team: null,
      default_project: null,
      fuzzy_auto_apply_score_gap: 0.2,
      folder_routes: {},
    },
    dedupe: {
      enabled: true,
      search_scope: "all_linear_issues",
      canonical_strategy: "newest_open_issue",
      merge_new_data_into_canonical: true,
    },
    sources: {
      fireflies: { enabled: true, connected: true },
      granola: { enabled: true, connected: true },
      obsidian: { enabled: true },
    },
    notifications: {
      enabled: false,
      slack_webhook_env_var: "SLACK_WEBHOOK_URL",
      slack_channel: null,
      cadence: "realtime",
      include_sources: ["fireflies", "granola"],
      include_systems: ["obsidian", "linear"],
      include_events: ["task_created", "daily_report", "manual_report"],
      daily_report: {
        enabled: true,
        hour_local: 8,
      },
      on_demand_report: {
        enabled: true,
      },
    },
    extractor: {
      max_items: 15,
      curated_mode: "prefer",
      commitment_phrases: [],
      owner_groups: {
        self: [],
        client: [],
        parking_lot_markers: [],
      },
    },
  };
}

function baseNote(overrides: Partial<CanonicalNote>): CanonicalNote {
  return {
    source: { source: "fireflies", url: "upload://test" },
    title: "Test",
    body: "Test body",
    people: [],
    tasks: [],
    confidence: 1,
    tags: [],
    authority: { source: "fireflies" },
    ...overrides,
  };
}

function writeIndex(workspaceRoot: string): void {
  const dir = join(workspaceRoot, "integrations/linear-vault-sync/router-index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify(
      {
        generatedAt: "2026-03-19T00:00:00Z",
        teams: [
          { id: "team-a", name: "Team A" },
          { id: "team-b", name: "Team B" },
        ],
        projects: [
          { id: "p1", name: "Shared Project", teamId: "team-a", teamName: "Team A" },
          { id: "p2", name: "Shared Project", teamId: "team-b", teamName: "Team B" },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(
    join(dir, "aliases.json"),
    JSON.stringify({ teamNameAliases: {}, projectNameAliases: {} }, null, 2),
    "utf8"
  );
}

function writeIndexWithFuzzyAmbiguity(workspaceRoot: string): void {
  const dir = join(workspaceRoot, "integrations/linear-vault-sync/router-index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify(
      {
        generatedAt: "2026-03-19T00:00:00Z",
        teams: [
          { id: "team-a", name: "Team A" },
          { id: "team-b", name: "Team B" },
        ],
        projects: [
          { id: "p1", name: "Sales Opportunities", teamId: "team-a", teamName: "Team A" },
          { id: "p2", name: "Sales Opportunities", teamId: "team-b", teamName: "Team B" },
          { id: "p3", name: "Revenue Forecast", teamId: "team-a", teamName: "Team A" },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(
    join(dir, "aliases.json"),
    JSON.stringify({ teamNameAliases: {}, projectNameAliases: {} }, null, 2),
    "utf8"
  );
}

test("does not auto-resolve ambiguous project name without team", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndex(workspaceRoot);
  const note = baseNote({ project: "Shared Project" });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.project, "Shared Project");
  assert.equal(route.team, null);
  assert.match(route.reason, /ambiguous/i);
});

test("resolves duplicate project name when team is supplied", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndex(workspaceRoot);
  const note = baseNote({ team: "Team B", project: "Shared Project" });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.team, "Team B");
  assert.equal(route.project, "Shared Project");
  assert.match(route.reason, /exact match/i);
});

test("does not auto-resolve fuzzy match when matched name is ambiguous across teams", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const note = baseNote({ project: "sales opportunitiez" });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.team, null);
  assert.equal(route.project, "sales opportunitiez");
  assert.match(route.reason, /shared by multiple teams/i);
});

test("explicit folder_routes entry routes team and project deterministically", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const config = baseConfig();
  config.routing.folder_routes = { "Gamma Studio": { team: "Team A", project: "Revenue Forecast" } };
  const note = baseNote({ folders: ["Gamma Studio"] });
  const route = resolveRouting(note, config, workspaceRoot);
  assert.equal(route.team, "Team A");
  assert.equal(route.project, "Revenue Forecast");
  assert.match(route.reason, /Granola folder: Gamma Studio/);
});

test("folder_routes matches folder name case-insensitively", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const config = baseConfig();
  config.routing.folder_routes = { "Gamma Studio": { team: "Team A", project: "Revenue Forecast" } };
  const note = baseNote({ folders: ["gamma studio"] });
  const route = resolveRouting(note, config, workspaceRoot);
  assert.equal(route.team, "Team A");
  assert.equal(route.project, "Revenue Forecast");
});

test("folder name is used as a project hint when it matches the Linear index", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const note = baseNote({ folders: ["Revenue Forecast"] });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.team, "Team A");
  assert.equal(route.project, "Revenue Forecast");
  assert.match(route.reason, /Granola folder: Revenue Forecast/);
});

test("generic folder name that matches nothing does not leak a bogus route", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const note = baseNote({ folders: ["Sales calls"] });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.team, null);
  assert.equal(route.project, null);
  assert.doesNotMatch(route.reason, /Granola folder/);
});

test("explicit note project wins over folder membership", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithFuzzyAmbiguity(workspaceRoot);
  const config = baseConfig();
  config.routing.folder_routes = { "Revenue Forecast": { team: "Team B", project: "Sales Opportunities" } };
  const note = baseNote({ team: "Team A", project: "Revenue Forecast", folders: ["Revenue Forecast"] });
  const route = resolveRouting(note, config, workspaceRoot);
  assert.equal(route.team, "Team A");
  assert.equal(route.project, "Revenue Forecast");
  assert.match(route.reason, /exact match/i);
});

test("applies aliases and still respects team-scoped disambiguation", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndex(workspaceRoot);
  const aliasesPath = join(workspaceRoot, "integrations/linear-vault-sync/router-index/aliases.json");
  writeFileSync(
    aliasesPath,
    JSON.stringify(
      {
        teamNameAliases: { "team beta": "Team B" },
        projectNameAliases: { "shared proj": "Shared Project" },
      },
      null,
      2
    ),
    "utf8"
  );
  const note = baseNote({ team: "team beta", project: "shared proj" });
  const route = resolveRouting(note, baseConfig(), workspaceRoot);
  assert.equal(route.team, "Team B");
  assert.equal(route.project, "Shared Project");
});

function writeIndexWithRetiredTeam(workspaceRoot: string): void {
  const dir = join(workspaceRoot, "integrations/linear-vault-sync/router-index");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "index.json"),
    JSON.stringify(
      {
        generatedAt: "2026-10-17T00:00:00Z",
        teams: [{ id: "team-a", name: "Team A" }],
        projects: [{ id: "p1", name: "Shared Project", teamId: "team-a", teamName: "Team A" }],
        retiredTeams: [{ id: "team-r", name: "Beta Games", retiredAt: "2026-10-01T00:00:00Z" }],
      },
      null,
      2
    ),
    "utf8"
  );
  writeFileSync(join(dir, "aliases.json"), JSON.stringify({ teamNameAliases: {}, projectNameAliases: {} }), "utf8");
}

test("drops a route whose team is retired in Linear so no Linear write is attempted", () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-router-routing-test-"));
  writeIndexWithRetiredTeam(workspaceRoot);
  const config = baseConfig();
  config.routing.folder_routes = { "Beta Games": { team: "Beta Games", project: "Beta Games" } };
  const note = baseNote({ source: { source: "granola", url: "granola://x" }, folders: ["Beta Games"] });
  const route = resolveRouting(note, config, workspaceRoot);
  assert.equal(route.team, null);
  assert.equal(route.project, null);
  assert.match(route.reason, /retired/i);
});
