import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import type { CanonicalNote } from "../normalize/note.js";
import type { ResolvedRoute } from "../resolve/routing.js";
import { writeFileIfChanged } from "./write.js";
import { yamlQuote } from "../server/security.js";

const SECTION_START = "<!-- ai-note-router:start -->";
const SECTION_END = "<!-- ai-note-router:end -->";
const MEETINGS_SECTION_START = "<!-- ai-note-router:meetings:start -->";
const MEETINGS_SECTION_END = "<!-- ai-note-router:meetings:end -->";
const PROJECT_TASKS_SECTION_START = "<!-- ai-note-router:project-tasks:start -->";
const PROJECT_TASKS_SECTION_END = "<!-- ai-note-router:project-tasks:end -->";
const DEFAULT_MANAGED_SUMMARY_MAX_CHARS = 4000;
// Map misspelled/alternate project slugs to canonical project names, e.g. "acme-analytic": "Acme Analytics".
const PROJECT_ALIAS_BY_SLUG: Record<string, string> = {};

export type ProjectNoteWriteResult = {
  filePath: string;
  created: boolean;
  updated: boolean;
  projectFilePath?: string;
  createdTaskTitles?: string[];
};

export function upsertProjectNote(
  workspaceRoot: string,
  note: CanonicalNote,
  route: ResolvedRoute,
  canonicalIssueId?: string
): ProjectNoteWriteResult {
  upsertUnknownPeopleCards(workspaceRoot, note, route);

  const rawProjectName = route.project || note.project || note.client || note.title;
  const projectName = normalizeProjectName(rawProjectName);
  const noteType = inferNoteType(note, projectName);
  if (noteType === "meeting") {
    const meetingTitle = deriveMeetingTitle(note, projectName);
    const meetingPath = join(workspaceRoot, "meetings", `${slugify(meetingTitle)}.md`);
    const section = buildManagedSection(note, route, canonicalIssueId);
    const projectPath = join(workspaceRoot, "projects", `${slugify(projectName)}.md`);

    const wroteMeeting = upsertSingleNote(
      meetingPath,
      note,
      section,
      meetingTitle,
      "meeting",
      route
    );
    upsertProjectMeetingsIndex(projectPath, projectName, note.tags, meetingPath, meetingTitle);
    return {
      filePath: wroteMeeting.filePath,
      created: wroteMeeting.created,
      updated: wroteMeeting.updated,
      projectFilePath: projectPath,
      createdTaskTitles: wroteMeeting.createdTaskTitles ?? [],
    };
  }

  const filePath = join(workspaceRoot, "projects", `${slugify(projectName)}.md`);
  const section = buildManagedSection(note, route, canonicalIssueId);
  return upsertSingleNote(filePath, note, section, projectName, "project", route);
}

function upsertUnknownPeopleCards(workspaceRoot: string, note: CanonicalNote, route: ResolvedRoute): void {
  if (note.people.length === 0) return;

  const peopleDir = join(workspaceRoot, "people");
  if (!existsSync(peopleDir)) {
    mkdirSync(peopleDir, { recursive: true });
  }

  const existing = new Set<string>();
  const files = readdirSync(peopleDir).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const filePath = join(peopleDir, file);
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const heading = content.match(/^#\s+(.+)\s*$/m)?.[1]?.trim() ?? "";
    const email = extractFrontmatterScalar(content, "email");
    if (heading) existing.add(`name:${normalizePersonKey(heading)}`);
    if (email) existing.add(`email:${normalizePersonKey(email)}`);
  }

  for (const person of note.people) {
    const rawName = (person.name ?? "").trim();
    const rawEmail = (person.email ?? "").trim();
    const normalizedEmail = rawEmail ? normalizePersonKey(rawEmail) : null;
    const normalizedName = rawName ? normalizePersonKey(rawName) : null;

    if (normalizedEmail && existing.has(`email:${normalizedEmail}`)) continue;
    if (normalizedName && existing.has(`name:${normalizedName}`)) continue;

    // Avoid creating cards for low-signal placeholders.
    if (!isAutoCreatablePerson(rawName, rawEmail)) continue;

    const titleName = derivePersonTitle(rawName, rawEmail);
    const filePath = join(peopleDir, `${slugify(titleName)}.md`);
    if (existsSync(filePath)) {
      existing.add(`name:${normalizePersonKey(titleName)}`);
      if (normalizedEmail) existing.add(`email:${normalizedEmail}`);
      continue;
    }

    const tags = inferPersonTags(note, route);
    const lines = [
      "---",
      "type: person",
      rawEmail ? `email: ${yamlQuote(rawEmail)}` : null,
      "tags:",
      ...tags.map((t) => `  - ${t}`),
      "last-contact:",
      "---",
      "",
      `# ${titleName}`,
      "",
      "Auto-created from meeting attendee during AI note routing.",
      "",
      "## Follow-ups",
      "- ",
      "",
      "## Notes",
      "- Tagged `needs-review` in frontmatter until you verify details.",
      note.source.externalId ? `- First seen in source: ${note.source.externalId}` : "- First seen in meeting ingestion.",
    ].filter((line): line is string => line !== null);

    writeFileSync(filePath, lines.join("\n"), "utf8");
    existing.add(`name:${normalizePersonKey(titleName)}`);
    if (normalizedEmail) existing.add(`email:${normalizedEmail}`);
  }
}

function extractFrontmatterScalar(content: string, key: string): string | null {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  const body = fm?.[1];
  if (!body) return null;
  const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  const value = m?.[1]?.trim() ?? "";
  return value ? value.replace(/^["']|["']$/g, "").trim() : null;
}

function normalizePersonKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
}

function isAutoCreatablePerson(name: string, email: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (!normalizedName && !email.trim()) return false;
  if (/^(speaker\s*[a-z0-9]+|unknown|me|them|guest)$/i.test(normalizedName)) return false;
  if (email.trim()) return true;
  return normalizedName.split(/\s+/).filter(Boolean).length >= 2;
}

function derivePersonTitle(name: string, email: string): string {
  const trimmed = name.trim();
  if (trimmed && trimmed.split(/\s+/).length >= 2) return trimmed;
  if (email.trim()) {
    const localPart = email.split("@")[0] ?? "";
    const words = localPart
      .split(/[._-]+/g)
      .map((w) => w.trim())
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    if (words.length >= 2) return words.join(" ");
  }
  return trimmed || email || "Unknown Person";
}

function inferPersonTags(note: CanonicalNote, route: ResolvedRoute): string[] {
  const tags = new Set<string>(["auto-created", "needs-review"]);
  if (route.project) tags.add(slugify(route.project));
  if (route.team) tags.add(slugify(route.team));
  for (const tag of note.tags) {
    const cleaned = slugify(tag);
    if (cleaned) tags.add(cleaned);
  }
  return Array.from(tags);
}

function upsertSingleNote(
  filePath: string,
  note: CanonicalNote,
  section: string,
  title: string,
  noteType: "project" | "meeting",
  route: ResolvedRoute
): ProjectNoteWriteResult {
  if (!existsSync(filePath)) {
    ensureDirectory(filePath);
    writeFileSync(filePath, buildNewNote(note, section, title, noteType, route), "utf8");
    return {
      filePath,
      created: true,
      updated: false,
      createdTaskTitles: noteType === "meeting" ? getActionableTaskTitles(note) : [],
    };
  }

  const existing = readFileSync(filePath, "utf8");
  const withType = ensureFrontmatterType(existing, noteType);
  const withProjectTasks = noteType === "project" ? ensureProjectTasksSection(withType) : withType;
  const mergedTasks =
    noteType === "meeting" ? mergeTasksSection(withProjectTasks, note) : { content: withProjectTasks, createdTaskTitles: [] };
  const updated = replaceManagedSection(mergedTasks.content, section);
  const changed = writeFileIfChanged(filePath, updated);
  return {
    filePath,
    created: false,
    updated: changed,
    createdTaskTitles: changed ? mergedTasks.createdTaskTitles : [],
  };
}

function buildNewNote(
  note: CanonicalNote,
  section: string,
  title: string,
  noteType: "project" | "meeting",
  route: ResolvedRoute
): string {
  const tasksSection = noteType === "meeting" ? buildTasksSection(note) : null;
  const projectTasksSection = noteType === "project" ? buildProjectTasksSection() : null;
  const dateLine =
    noteType === "meeting"
      ? (note.source.capturedAt ? `date: ${note.source.capturedAt.slice(0, 10)}` : null)
      : null;
  const projectLine =
    noteType === "meeting"
      ? `project: ${route.project || note.project || note.client || "unassigned"}`
      : null;
  const teamLine =
    noteType === "meeting"
      ? `team: ${route.team || "unassigned"}`
      : null;

  return [
    "---",
    `type: ${noteType}`,
    "status: active",
    dateLine,
    projectLine,
    teamLine,
    `tags: [${note.tags.map((tag) => tag.replace(/]/g, "\\]")).join(", ")}]`,
    "---",
    "",
    `# ${title}`,
    "",
    "## Next Action",
    "- Define the next actionable step.",
    "",
    "## Notes",
    "- Created or updated by the AI note router.",
    "",
    ...(projectTasksSection ? [projectTasksSection, ""] : []),
    ...(tasksSection ? [tasksSection, ""] : []),
    section,
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

function buildManagedSection(note: CanonicalNote, route: ResolvedRoute, canonicalIssueId?: string): string {
  const summaryBody = truncateManagedSummary(note.body);
  const projectName = normalizeProjectName(route.project || note.project || note.client || "");
  const projectLink = projectName ? `[[projects/${slugify(projectName)}|${projectName}]]` : null;
  const peopleLinks = note.people
    .map((person) => derivePersonTitle(person.name ?? "", person.email ?? ""))
    .filter((name) => name && name !== "Unknown Person")
    .map((name) => `[[people/${slugify(name)}|${name}]]`);
  const uniquePeopleLinks = Array.from(new Set(peopleLinks));
  return [
    SECTION_START,
    "## AI Note Router",
    "",
    `Source: ${note.source.source}: ${note.source.url}`,
    note.source.externalId ? `Source ID: ${note.source.externalId}` : null,
    note.source.capturedAt ? `Captured: ${note.source.capturedAt}` : null,
    `Route: ${route.team || "unassigned"} / ${route.project || "unassigned"}`,
    `Reason: ${route.reason}`,
    canonicalIssueId ? `Linear: ${canonicalIssueId}` : "Linear: not linked yet",
    projectLink ? `Project note: ${projectLink}` : null,
    uniquePeopleLinks.length > 0 ? `People: ${uniquePeopleLinks.join(", ")}` : null,
    "",
    "Summary:",
    summaryBody,
    SECTION_END,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function replaceManagedSection(existing: string, section: string): string {
  const pattern = new RegExp(`${escapeRegExp(SECTION_START)}[\\s\\S]*?${escapeRegExp(SECTION_END)}`, "m");
  if (pattern.test(existing)) {
    return existing.replace(pattern, section);
  }

  return `${existing.trimEnd()}\n\n${section}\n`;
}

// `$` is intentionally end-of-string (no `m` flag) so the match consumes the
// whole tasks section, including `### ` subheaders, when no trailing `## ` or
// trace block is found.
function tasksSectionPattern(): RegExp {
  return new RegExp(`## Tasks\\n[\\s\\S]*?(?=\\n## |\\n${escapeRegExp(SECTION_START)}|$)`);
}

function replaceTasksSection(existing: string, tasksSection: string): string {
  const pattern = tasksSectionPattern();
  if (pattern.test(existing)) {
    return existing.replace(pattern, tasksSection);
  }
  return `${existing.trimEnd()}\n\n${tasksSection}\n`;
}

function mergeTasksSection(existing: string, note: CanonicalNote): { content: string; createdTaskTitles: string[] } {
  const pattern = tasksSectionPattern();
  if (!pattern.test(existing)) {
    return {
      content: `${existing.trimEnd()}\n\n${buildTasksSection(note)}\n`,
      createdTaskTitles: getActionableTaskTitles(note),
    };
  }

  const currentSection = existing.match(pattern)?.[0] ?? "## Tasks";
  const existingLines = currentSection.split(/\r?\n/).slice(1);
  const existingTaskKeys = new Set(
    existingLines
      .map((line) => normalizeTaskTitle(extractTaskTitle(line)))
      .filter((key) => key !== "__no_tasks_placeholder__")
  );
  // Preserve only completed/manual checked tasks; regenerate unchecked tasks from parser output.
  const preservedLines = existingLines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().startsWith("- [x]") || line.trim().startsWith("- [X]"))
    .filter((line) => normalizeTaskTitle(extractTaskTitle(line)) !== "__no_tasks_placeholder__");

  const nextSection = hasOwnerGrouping(note)
    ? mergeGroupedTasks(note, preservedLines, existingTaskKeys)
    : mergeFlatTasks(note, preservedLines, existingTaskKeys);

  // Trailing `\n` preserves the blank line between the Tasks section and the
  // following `<!-- ai-note-router:start -->` block that the regex consumed.
  return {
    content: existing.replace(pattern, `${nextSection.section}\n`),
    createdTaskTitles: nextSection.createdTaskTitles,
  };
}

function mergeFlatTasks(
  note: CanonicalNote,
  preservedLines: string[],
  existingTaskKeys: Set<string>
): { section: string; createdTaskTitles: string[] } {
  const extractedLines = buildTaskLines(note);
  const seen = new Set<string>();
  const merged: string[] = [];
  const createdTaskTitles: string[] = [];

  for (const line of preservedLines) {
    const key = normalizeTaskTitle(extractTaskTitle(line));
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(line);
    }
  }

  for (const line of extractedLines) {
    const key = normalizeTaskTitle(extractTaskTitle(line));
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(line);
      if (key !== "__no_tasks_placeholder__" && !existingTaskKeys.has(key)) {
        createdTaskTitles.push(extractTaskTitle(line));
      }
    }
  }

  return { section: buildTasksSectionFromLines(merged), createdTaskTitles };
}

function mergeGroupedTasks(
  note: CanonicalNote,
  preservedLines: string[],
  existingTaskKeys: Set<string>
): { section: string; createdTaskTitles: string[] } {
  const preservedByKey = new Map<string, string>();
  for (const line of preservedLines) {
    const key = normalizeTaskTitle(extractTaskTitle(line));
    if (!preservedByKey.has(key)) preservedByKey.set(key, line);
  }

  const byGroup: Record<"self" | "client" | "parking_lot", string[]> = {
    self: [],
    client: [],
    parking_lot: [],
  };
  const usedPreserved = new Set<string>();
  const createdTaskTitles: string[] = [];

  for (const task of note.tasks) {
    const group = task.ownerGroup ?? "parking_lot";
    const extractedLine = renderTaskLine(task);
    const key = normalizeTaskTitle(extractTaskTitle(extractedLine));
    const preservedLine = preservedByKey.get(key);
    if (preservedLine !== undefined) {
      byGroup[group].push(preservedLine);
      usedPreserved.add(key);
    } else {
      byGroup[group].push(extractedLine);
      if (!existingTaskKeys.has(key)) {
        createdTaskTitles.push(extractTaskTitle(extractedLine));
      }
    }
  }

  const orphanedCompleted: string[] = [];
  for (const [key, line] of preservedByKey) {
    if (!usedPreserved.has(key)) orphanedCompleted.push(line);
  }

  return { section: assembleGroupedSection(byGroup, orphanedCompleted), createdTaskTitles };
}

export function buildTasksSection(note: CanonicalNote): string {
  if (note.tasks.length > 0 && hasOwnerGrouping(note)) {
    return buildGroupedTaskSection(note);
  }
  return buildTasksSectionFromLines(buildTaskLines(note));
}

function hasOwnerGrouping(note: CanonicalNote): boolean {
  return note.tasks.some((t) => t.ownerGroup !== undefined);
}

function buildGroupedTaskSection(note: CanonicalNote): string {
  const byGroup: Record<"self" | "client" | "parking_lot", string[]> = {
    self: [],
    client: [],
    parking_lot: [],
  };
  for (const task of note.tasks) {
    const group = task.ownerGroup ?? "parking_lot";
    byGroup[group].push(renderTaskLine(task));
  }
  return assembleGroupedSection(byGroup, []);
}

function renderTaskLine(task: CanonicalNote["tasks"][number]): string {
  const details: string[] = [];
  const description = task.description?.trim();
  if (description) details.push(description);
  if (task.assigneeName) details.push(`owner: ${task.assigneeName}`);
  if (task.dueDate) details.push(`due: ${task.dueDate}`);
  const suffix = details.length > 0 ? ` — ${details.join(" | ")}` : "";
  return `- [ ] ${task.title}${suffix}`;
}

function assembleGroupedSection(
  byGroup: Record<"self" | "client" | "parking_lot", string[]>,
  orphanedCompleted: string[]
): string {
  const parts: string[] = ["## Tasks"];
  const sections: Array<{ title: string; key: "self" | "client" | "parking_lot" }> = [
    { title: "### Mine", key: "self" },
    { title: "### Client", key: "client" },
    { title: "### Open Questions / Parking Lot", key: "parking_lot" },
  ];
  for (const section of sections) {
    const lines = byGroup[section.key];
    if (lines.length === 0) continue;
    parts.push("");
    parts.push(section.title);
    parts.push(...lines);
  }
  if (orphanedCompleted.length > 0) {
    parts.push("");
    parts.push("### Completed");
    parts.push(...orphanedCompleted);
  }
  if (parts.length === 1) {
    parts.push("- [ ] No tasks extracted yet.");
  }
  return parts.join("\n");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeProjectName(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) return "";
  const canonical = PROJECT_ALIAS_BY_SLUG[slugify(trimmed)];
  return canonical || trimmed;
}

function ensureDirectory(filePath: string): void {
  const directory = dirname(filePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function inferNoteType(note: CanonicalNote, projectName: string): "project" | "meeting" {
  if (note.source.source === "fireflies" || note.source.source === "granola") {
    return "meeting";
  }

  const title = note.title.trim().toLowerCase();
  const project = projectName.trim().toLowerCase();
  const body = note.body.trim().toLowerCase();
  const looksLikeMeeting =
    title.startsWith("meeting title:") ||
    /\bmeeting\b/.test(title) ||
    /\bmeeting\b/.test(project) ||
    /^meeting title\s*:/im.test(note.body) ||
    body.includes("transcript:");
  return looksLikeMeeting ? "meeting" : "project";
}

function deriveMeetingTitle(note: CanonicalNote, projectName: string): string {
  const title = note.title.trim();
  const stripped = title.replace(/^meeting title:\s*/i, "").trim();
  const bodyMeetingTitle = readMeetingTitle(note.body);
  if (stripped && !isGenericMeetingTitle(stripped)) return stripped;
  if (bodyMeetingTitle) return bodyMeetingTitle;
  if (stripped) return stripped;
  if (projectName) return `${projectName} Meeting`;
  return "Meeting";
}

function readMeetingTitle(value: string): string | null {
  const lines = value.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^meeting title\s*:\s*(.+)$/i);
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

function isGenericMeetingTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "transcript" || normalized === "meeting";
}

function buildTaskLines(note: CanonicalNote): string[] {
  if (note.tasks.length === 0) return ["- [ ] No tasks extracted yet."];
  return note.tasks.map((task) => {
    const details: string[] = [];
    const description = task.description?.trim();
    if (description) details.push(description);
    if (task.assigneeName) details.push(`owner: ${task.assigneeName}`);
    if (task.dueDate) details.push(`due: ${task.dueDate}`);
    const suffix = details.length > 0 ? ` — ${details.join(" | ")}` : "";
    return `- [ ] ${task.title}${suffix}`;
  });
}

function buildTasksSectionFromLines(lines: string[]): string {
  const safeLines = lines.length > 0 ? lines : ["- [ ] No tasks extracted yet."];
  return ["## Tasks", ...safeLines].join("\n");
}

function extractTaskTitle(line: string): string {
  const match = line.match(/^- \[[ xX]\]\s+(.+?)(?:\s+—\s+.*)?$/);
  return match?.[1]?.trim() ?? line.trim();
}

function normalizeTaskTitle(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "no tasks extracted yet.") return "__no_tasks_placeholder__";
  return normalized.replace(/[^a-z0-9]+/g, " ").trim();
}

function getActionableTaskTitles(note: CanonicalNote): string[] {
  return buildTaskLines(note)
    .map((line) => extractTaskTitle(line))
    .filter((title) => normalizeTaskTitle(title) !== "__no_tasks_placeholder__");
}

function truncateManagedSummary(body: string): string {
  const maxChars = readManagedSummaryMaxChars();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n[truncated ${body.length - maxChars} chars]`;
}

function readManagedSummaryMaxChars(): number {
  const raw = process.env.ROUTER_MANAGED_SUMMARY_MAX_CHARS;
  if (!raw) return DEFAULT_MANAGED_SUMMARY_MAX_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 500) return DEFAULT_MANAGED_SUMMARY_MAX_CHARS;
  return Math.floor(parsed);
}

function ensureFrontmatterType(content: string, noteType: "project" | "meeting"): string {
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!fmMatch) return content;
  const full = fmMatch[0];
  const body = fmMatch[1] ?? "";

  if (/^type:\s*/m.test(body)) {
    const updatedBody = body.replace(/^type:\s*[^\n\r]+/m, `type: ${noteType}`);
    return `${full.replace(body, updatedBody)}${content.slice(full.length)}`;
  }

  const updatedBody = `type: ${noteType}\n${body}`;
  return `${full.replace(body, updatedBody)}${content.slice(full.length)}`;
}

function upsertProjectMeetingsIndex(
  projectPath: string,
  projectName: string,
  tags: string[],
  meetingPath: string,
  meetingTitle: string
): void {
  const meetingBasename = basename(meetingPath, ".md");
  const meetingLink = `- [[meetings/${meetingBasename}|${meetingTitle}]]`;

  if (!existsSync(projectPath)) {
    ensureDirectory(projectPath);
    writeFileSync(
      projectPath,
      [
        "---",
        "type: project",
        "status: active",
        `tags: [${tags.map((tag) => tag.replace(/]/g, "\\]")).join(", ")}]`,
        "---",
        "",
        `# ${projectName}`,
        "",
        "## Next Action",
        "- Define the next actionable step.",
        "",
        "## Notes",
        "- Created or updated by the AI note router.",
        "",
        buildProjectTasksSection(),
        "",
        buildMeetingsSection([meetingLink]),
        "",
      ].join("\n"),
      "utf8"
    );
    return;
  }

  const existing = readFileSync(projectPath, "utf8");
  const updated = replaceMeetingsSection(existing, meetingLink);
  writeFileIfChanged(projectPath, updated);
}

function replaceMeetingsSection(existing: string, meetingLink: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(MEETINGS_SECTION_START)}[\\s\\S]*?${escapeRegExp(MEETINGS_SECTION_END)}`,
    "m"
  );
  if (pattern.test(existing)) {
    const matched = existing.match(pattern)?.[0] ?? "";
    const lines = matched.split(/\r?\n/);
    const hasLink = lines.some((line) => line.trim() === meetingLink.trim());
    if (hasLink) return existing;
    const inserted = matched.replace(
      MEETINGS_SECTION_END,
      `${meetingLink}\n${MEETINGS_SECTION_END}`
    );
    return existing.replace(pattern, inserted);
  }

  return `${existing.trimEnd()}\n\n${buildMeetingsSection([meetingLink])}\n`;
}

function buildMeetingsSection(links: string[]): string {
  return [
    MEETINGS_SECTION_START,
    "## Meetings",
    "",
    ...links,
    MEETINGS_SECTION_END,
  ].join("\n");
}

function ensureProjectTasksSection(existing: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(PROJECT_TASKS_SECTION_START)}[\\s\\S]*?${escapeRegExp(PROJECT_TASKS_SECTION_END)}`,
    "m"
  );
  if (pattern.test(existing)) {
    return existing;
  }
  return `${existing.trimEnd()}\n\n${buildProjectTasksSection()}\n`;
}

function buildProjectTasksSection(): string {
  return [
    PROJECT_TASKS_SECTION_START,
    "## Tasks by Status",
    "",
    "> [!todo]+ In Progress",
    "> ```dataview",
    "> LIST file.link FROM \"tasks\"",
    "> WHERE contains(file.tags, this.tags[0]) AND status = \"in-progress\"",
    "> SORT file.name ASC",
    "> ```",
    "",
    "> [!abstract]+ Pending",
    "> ```dataview",
    "> LIST file.link FROM \"tasks\"",
    "> WHERE contains(file.tags, this.tags[0]) AND status = \"pending\"",
    "> SORT file.name ASC",
    "> ```",
    "",
    "> [!success]- Complete",
    "> ```dataview",
    "> LIST file.link FROM \"tasks\"",
    "> WHERE contains(file.tags, this.tags[0]) AND status = \"complete\"",
    "> SORT file.name ASC",
    "> ```",
    "",
    "> [!failure]- Cancelled",
    "> ```dataview",
    "> LIST file.link FROM \"tasks\"",
    "> WHERE contains(file.tags, this.tags[0]) AND status = \"cancelled\"",
    "> SORT file.name ASC",
    "> ```",
    PROJECT_TASKS_SECTION_END,
  ].join("\n");
}
