import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { RouterConfig } from "../config/types.js";
import { loadProcessedState } from "../state/processed.js";
import { startInboxWatcher } from "./watch.js";

function config(): RouterConfig {
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
    dedupe: { enabled: false, search_scope: "all_linear_issues", canonical_strategy: "newest_open_issue", merge_new_data_into_canonical: true },
    sources: { fireflies: { enabled: true, connected: true }, granola: { enabled: true, connected: true }, obsidian: { enabled: true } },
    notifications: {
      enabled: false,
      slack_webhook_env_var: "SLACK_WEBHOOK_URL",
      slack_channel: null,
      cadence: "realtime",
      include_sources: ["fireflies", "granola"],
      include_systems: ["obsidian", "linear"],
      include_events: ["task_created", "daily_report", "manual_report"],
      daily_report: { enabled: true, hour_local: 8 },
      on_demand_report: { enabled: true },
    },
    extractor: { max_items: 15, curated_mode: "prefer", commitment_phrases: [], owner_groups: { self: [], client: [], parking_lot_markers: [] } },
  };
}

function setup(ids: string[]): { workspaceRoot: string; inboxDir: string; statePath: string } {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "watch-"));
  const inboxDir = join(workspaceRoot, "inbox");
  mkdirSync(inboxDir);
  ids.forEach((id, i) => {
    writeFileSync(
      join(inboxDir, `2026-10-17T15-00-0${i}-000Z-fireflies-${id}.json`),
      JSON.stringify({ source: "fireflies", id, url: `https://x/${id}`, title: id, body: "meeting title: Test" }),
      "utf8"
    );
  });
  return { workspaceRoot, inboxDir, statePath: join(workspaceRoot, "state.json") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("records a terminal Linear failure as skipped and never retries it", async () => {
  const { workspaceRoot, inboxDir, statePath } = setup(["RETIRED"]);
  let calls = 0;
  const handle = await startInboxWatcher({
    workspaceRoot,
    inboxDir,
    statePath,
    config: config(),
    dryRun: false,
    pollIntervalMs: 30,
    executeNoteFn: async () => {
      calls += 1;
      throw new Error("Linear API errors: Entity is retired: team");
    },
  });
  await sleep(250);
  await handle.stop();
  assert.equal(calls, 1);
  const state = loadProcessedState(statePath);
  assert.equal(state.skippedFingerprints.length, 1);
  assert.equal(state.skippedFingerprints[0]?.fingerprint, "fireflies:RETIRED");
  assert.match(state.skippedFingerprints[0]?.reason ?? "", /retired/i);
});

test("stops the scan on a rate-limit error instead of moving to the next file", async () => {
  const { workspaceRoot, inboxDir, statePath } = setup(["FIRST", "SECOND"]);
  const seen: string[] = [];
  const handle = await startInboxWatcher({
    workspaceRoot,
    inboxDir,
    statePath,
    config: config(),
    dryRun: false,
    pollIntervalMs: 30,
    executeNoteFn: async (note) => {
      seen.push(note.source.externalId ?? "");
      throw new Error('Linear API error 400: {"errors":[{"message":"Rate limit exceeded. Only 2500 requests are allowed per 1 hour."}]}');
    },
  });
  await sleep(250);
  await handle.stop();
  assert.deepEqual(seen, ["FIRST"]);
});

test("does not retry a transiently failed file on the very next scan", async () => {
  const { workspaceRoot, inboxDir, statePath } = setup(["FLAKY"]);
  let calls = 0;
  const handle = await startInboxWatcher({
    workspaceRoot,
    inboxDir,
    statePath,
    config: config(),
    dryRun: false,
    pollIntervalMs: 30,
    retryBaseDelayMs: 60_000,
    executeNoteFn: async () => {
      calls += 1;
      throw new Error("fetch failed");
    },
  });
  await sleep(250);
  await handle.stop();
  assert.equal(calls, 1);
});
