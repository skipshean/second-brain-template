#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../..");

const coreDocs = [
  "README.md",
  "CLAUDE.md",
  "integrations/ai-note-router/README.md",
  "integrations/linear-vault-sync/README.md",
  "integrations/linear-vault-sync/router-index/README.md",
  "docs/ai-note-router/meeting-ingestion-lifecycle.md",
  "integrations/TEST-PLAN.md",
  "projects/fireflies-granola-ingestion-setup.md",
];

const forbiddenPatterns = [
  { pattern: /\.Codex\//, message: "legacy .Codex path" },
  { pattern: /\bsecond-brain-ai-router\b/, message: "stale repo name reference" },
  { pattern: /\blaunchctl\s+load\b/, message: "legacy launchctl command (prefer bootstrap)" },
];

const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

const issues = [];

for (const relativePath of coreDocs) {
  const absolutePath = resolve(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    issues.push(`${relativePath}: missing core doc file`);
    continue;
  }
  const content = readFileSync(absolutePath, "utf8");
  for (const rule of forbiddenPatterns) {
    if (rule.pattern.test(content)) {
      issues.push(`${relativePath}: contains ${rule.message}`);
    }
  }
  for (const match of content.matchAll(markdownLinkPattern)) {
    const rawTarget = (match[1] ?? "").trim();
    if (!rawTarget || rawTarget.startsWith("#")) continue;
    if (rawTarget.startsWith("http://") || rawTarget.startsWith("https://") || rawTarget.startsWith("mailto:")) continue;
    const target = rawTarget.split("#", 1)[0];
    if (!target) continue;
    const resolvedTarget = target.startsWith("/")
      ? resolve(repoRoot, `.${target}`)
      : resolve(dirname(absolutePath), target);
    if (!existsSync(resolvedTarget)) {
      issues.push(`${relativePath}: broken local link -> ${rawTarget}`);
    }
  }
}

if (issues.length > 0) {
  console.error("Core docs check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`Core docs check passed (${coreDocs.length} files).`);
