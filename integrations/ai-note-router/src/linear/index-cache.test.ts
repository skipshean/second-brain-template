import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadLinearIndex, syncLinearIndex } from "./index-cache.js";

test("sync excludes retired teams and their projects from the routing index", async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "linear-index-"));
  const fakeClient = {
    async listTeamsWithProjects() {
      return [
        { id: "t1", name: "my-company", retiredAt: null, projects: [{ id: "p1", name: "Gamma Studio" }] },
        { id: "t2", name: "Beta Games", retiredAt: "2026-10-01T00:00:00.000Z", projects: [{ id: "p2", name: "Beta Games" }] },
      ];
    },
  };

  const summary = await syncLinearIndex(workspaceRoot, fakeClient);
  assert.equal(summary.teams, 1);
  assert.equal(summary.projects, 1);

  const index = loadLinearIndex(workspaceRoot);
  assert.ok(index);
  assert.deepEqual(index.teams.map((t) => t.name), ["my-company"]);
  assert.deepEqual(index.projects.map((p) => p.name), ["Gamma Studio"]);
  assert.deepEqual(index.retiredTeams, [{ id: "t2", name: "Beta Games", retiredAt: "2026-10-01T00:00:00.000Z" }]);

  const teamsMd = readFileSync(join(workspaceRoot, "integrations/linear-vault-sync/router-index/teams.md"), "utf8");
  const [routableTable, retiredSection] = teamsMd.split("## Retired teams");
  assert.ok(!/\| Beta Games \|/.test(routableTable ?? ""), "retired team should not be offered as a route");
  assert.match(retiredSection ?? "", /\| Beta Games \| t2 \|/);
});
