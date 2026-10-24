#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const workspaceRoot = process.cwd();
const routerPort = Number(process.env.ROUTER_PORT || "3333");
const indexPath = join(workspaceRoot, "integrations/linear-vault-sync/router-index/index.json");
const uploadAuditDir = join(workspaceRoot, "outputs/ai-note-router/uploads");

const results = {
  routerHealth: await checkRouterHealth(routerPort),
  linearIndex: checkLinearIndex(indexPath),
  latestUpload: checkLatestUpload(uploadAuditDir),
};

printReport(results);

async function checkRouterHealth(port) {
  const url = `http://localhost:${port}/health`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, message: `Health endpoint returned ${response.status}.`, url };
    }
    const json = await response.json();
    const isOk = Boolean(json?.ok);
    return {
      ok: isOk,
      message: isOk ? "Router health endpoint reachable." : "Router responded but did not report ok=true.",
      url,
    };
  } catch {
    return { ok: false, message: "Router health endpoint not reachable.", url };
  }
}

function checkLinearIndex(path) {
  if (!existsSync(path)) {
    return { ok: false, message: "Linear index missing.", ageMinutes: null };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const generatedAt = parsed.generatedAt ? new Date(parsed.generatedAt) : null;
    const teams = Array.isArray(parsed.teams) ? parsed.teams.length : 0;
    const projects = Array.isArray(parsed.projects) ? parsed.projects.length : 0;
    const ageMinutes = generatedAt ? Math.floor((Date.now() - generatedAt.getTime()) / 60000) : null;
    const ok = ageMinutes !== null && ageMinutes <= 24 * 60;
    return {
      ok,
      message:
        ageMinutes === null
          ? "Linear index timestamp missing."
          : `Linear index age: ${ageMinutes} min (teams: ${teams}, projects: ${projects}).`,
      ageMinutes,
    };
  } catch {
    return { ok: false, message: "Linear index unreadable.", ageMinutes: null };
  }
}

function checkLatestUpload(dir) {
  if (!existsSync(dir)) {
    return { ok: false, message: "No upload audit directory found." };
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(dir, name));
  if (files.length === 0) {
    return { ok: false, message: "No upload audit logs found." };
  }

  const newest = files
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];

  const content = readFileSync(newest.path, "utf8");
  const resultLine = content
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith("- result:"));

  const resultValue = resultLine ? resultLine.split(":").slice(1).join(":").trim().toLowerCase() : "unknown";
  const ok = resultValue === "successful";
  return {
    ok,
    message: `Latest upload: ${resultValue}.`,
    file: newest.path.replace(`${workspaceRoot}/`, ""),
  };
}

function printReport(data) {
  const checks = [
    ["Router health", data.routerHealth],
    ["Linear index", data.linearIndex],
    ["Latest upload", data.latestUpload],
  ];

  console.log("AI Router Health Check");
  console.log("======================");
  for (const [label, result] of checks) {
    const status = result.ok ? "OK" : "WARN";
    console.log(`${status}  ${label}: ${result.message}`);
    if (result.url) console.log(`     ${result.url}`);
    if (result.file) console.log(`     ${result.file}`);
  }
}
