import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export type LinearRouteOverride = { team: string; project: string };
export type LinearRouteOverrides = Record<string, LinearRouteOverride>;

function loadLinearRouteOverrides(workspaceRoot: string): LinearRouteOverrides {
  const path = join(workspaceRoot, "integrations/ai-note-router/config/linear-route-overrides.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object") return {};
    const out: LinearRouteOverrides = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof key === "string" && value !== null && typeof value === "object" && "team" in value && "project" in value) {
        const v = value as { team: unknown; project: unknown };
        if (typeof v.team === "string" && typeof v.project === "string") {
          const entry = { team: v.team, project: v.project };
          out[key] = entry;
          out[key.toUpperCase()] = entry; // allow 16w-1403 or 16W-1403
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}
import type { RouterConfig } from "../config/types.js";
import { LinearClient } from "../clients/linear.js";
import { inferRouteFromVaultParticipants } from "../resolve/inferFromVaultParticipants.js";
import { resolveRouting } from "../resolve/routing.js";
import type { CanonicalNote } from "../normalize/note.js";
import { logAudit } from "../audit/log.js";
import type { LinearUnassignedIssue } from "../clients/linear.js";

type VaultPersonCard = {
  name: string;
  nameLower: string;
  lastNameLower: string;
};

type VaultProjectFrontmatter = {
  status?: string;
  tags: string[];
};

type VaultProjectCard = {
  // Text used to match the issue (e.g. meeting title -> project note heading)
  matchTitle: string;
  matchTitleLower: string;
  // Resolved routing target extracted from the existing managed section:
  // `Route: <team> / <project>`
  routeTeam: string | null;
  routeProject: string | null;
};

let peopleCache: { workspaceRoot: string; cards: VaultPersonCard[] } | null = null;
let projectFrontmatterCache: { workspaceRoot: string; bySlug: Map<string, VaultProjectFrontmatter> } | null = null;
let projectsCache: { workspaceRoot: string; cards: VaultProjectCard[] } | null = null;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLabelName(name: string): string {
  // Linear labels often use spaces/case ("Epsilon Group") while vault tags use slugs ("epsilon-group").
  // Slugifying both sides makes the match robust.
  return slugify(name);
}

function labelDisplayNameFromVaultTag(tag: string): string {
  const cleaned = tag.trim();
  if (!cleaned) return cleaned;
  // Convert `epsilon-group` -> `Epsilon Group`
  const withSpaces = cleaned.replace(/[-_]+/g, " ");
  return withSpaces
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getVaultPeople(workspaceRoot: string): VaultPersonCard[] {
  if (peopleCache?.workspaceRoot === workspaceRoot) return peopleCache.cards;

  const peopleDir = join(workspaceRoot, "people");
  const cards: VaultPersonCard[] = [];

  try {
    const files = readdirSync(peopleDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(peopleDir, file);
      const content = readFileSync(filePath, "utf8");
      const headingMatch = content.match(/^#\s*(.+)\s*$/m);
      const heading = (headingMatch?.[1] ?? file.replace(/\.md$/, "")).trim();
      const nameLower = heading.toLowerCase();
      const lastNameLower = nameLower.split(/\s+/).filter(Boolean).slice(-1)[0] ?? nameLower;
      if (!heading) continue;
      cards.push({ name: heading, nameLower, lastNameLower });
    }
  } catch {
    // keep empty; inference will no-op
  }

  peopleCache = { workspaceRoot, cards };
  return cards;
}

function getVaultProjects(workspaceRoot: string): VaultProjectCard[] {
  if (projectsCache?.workspaceRoot === workspaceRoot) return projectsCache.cards;

  const projectsDir = join(workspaceRoot, "projects");
  const cards: VaultProjectCard[] = [];

  try {
    const files = readdirSync(projectsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const filePath = join(projectsDir, file);
      const content = readFileSync(filePath, "utf8");
      const titleMatch = content.match(/^#\s*(.+)\s*$/m);
      const matchTitle = titleMatch?.[1]?.trim();
      if (!matchTitle) continue;

      // Prefer extracting the router-managed Route block.
      const managedRouteStart = content.indexOf("<!-- ai-note-router:start -->");
      const managedRouteEnd = content.indexOf("<!-- ai-note-router:end -->");
      const managedSection = managedRouteStart >= 0 && managedRouteEnd > managedRouteStart
        ? content.slice(managedRouteStart, managedRouteEnd)
        : "";

      const routeLine = managedSection.match(/Route:\s*([^\n\r]+?)\s*\/\s*([^\n\r]+)/i);
      const managedTeam = routeLine?.[1]?.trim() ?? null;
      const managedProject = routeLine?.[2]?.trim() ?? null;

      // Fallback: some project files have a `- Team:` line near the top.
      const teamMatch = content.match(/-?\s*Team:\s*([^,\n]+)/i);
      const team = managedTeam ?? teamMatch?.[1]?.trim() ?? null;

      const project = managedProject ?? matchTitle;

      cards.push({
        matchTitle,
        matchTitleLower: matchTitle.toLowerCase(),
        routeTeam: team,
        routeProject: project,
      });
    }
  } catch {
    // keep empty; inference will no-op
  }

  projectsCache = { workspaceRoot, cards };
  return cards;
}

function inferRouteFromProjectTitleMentions(
  text: string,
  cards: VaultProjectCard[],
  config: RouterConfig
): { team: string | null; project: string | null; reason: string } {
  const t = (text ?? "").toLowerCase();
  let best: VaultProjectCard | null = null;
  let bestScore = 0;

  for (const card of cards) {
    if (!card.matchTitleLower) continue;
    if (!t.includes(card.matchTitleLower)) continue;

    // Prefer longer matches (usually more specific).
    const score = card.matchTitleLower.length;
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }

  if (!best) {
    return { team: null, project: null, reason: "Needs review: project title not found in issue text." };
  }

  return {
    team: best.routeTeam ?? config.routing.default_team,
    project: best.routeProject,
    reason: "Inferred team/project from project title mention in issue text.",
  };
}

function extractAssignedPersonNames(text: string): string[] {
  const input = text ?? "";
  const patterns: RegExp[] = [
    /assigned to\s+([^.\n\r]{3,140})/gi,
    /assignee\s*:\s*([^.\n\r]{3,140})/gi,
    /owner\s*:\s*([^.\n\r]{3,140})/gi,
  ];

  const out: string[] = [];
  for (const p of patterns) {
    for (const match of input.matchAll(p)) {
      const raw = (match[1] ?? "").trim();
      if (!raw) continue;
      // Common separators in meeting notes.
      const parts = raw
        .split(/,| and | & /gi)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

      for (const part of parts) {
        // Keep something that looks like a person name.
        if (/[A-Za-z]/.test(part) && part.split(/\s+/).filter(Boolean).length >= 2) {
          out.push(part);
        }
      }
    }
  }

  return Array.from(new Set(out));
}

function extractVaultPeopleFromText(text: string, cards: VaultPersonCard[]): VaultPersonCard[] {
  const t = (text ?? "").toLowerCase();
  const out: VaultPersonCard[] = [];
  const seen = new Set<string>();

  for (const card of cards) {
    const fullHit = card.nameLower && t.includes(card.nameLower);
    const last = card.lastNameLower;
    const lastHit = last && last.length > 2 ? new RegExp(`\\b${escapeRegExp(last)}\\b`, "i").test(text) : false;

    if (!fullHit && !lastHit) continue;
    if (seen.has(card.nameLower)) continue;
    seen.add(card.nameLower);
    out.push(card);
  }

  return out;
}

function normalizePersonNameLower(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function lastNameLowerFromFullName(nameLower: string): string {
  return nameLower.split(/\s+/).filter(Boolean).slice(-1)[0] ?? nameLower;
}

function parseYamlInlineList(value: string): string[] {
  // For our use-case, tags are typically written as: tags: [a, b]
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1);
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(content: string): VaultProjectFrontmatter | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) return null;

  const frontmatter = match[1] ?? "";

  const statusMatch = frontmatter.match(/(^|\n)status:\s*([^\n\r]+)/);
  const status = statusMatch?.[2]?.trim();

  const tagsInlineMatch = frontmatter.match(/(^|\n)tags:\s*\[([^\]]+)\]/);
  if (tagsInlineMatch) {
    const tags = parseYamlInlineList(`[${
      tagsInlineMatch[2] ?? ""
    }]`);
    const out: VaultProjectFrontmatter = { tags };
    if (status) out.status = status;
    return out;
  }

  // Multiline list: tags:\n  - a\n  - b
  const tagsKeyIndex = frontmatter.indexOf("tags:");
  if (tagsKeyIndex !== -1) {
    const after = frontmatter.slice(tagsKeyIndex);
    const lines = after.split(/\r?\n/).slice(1);
    const tags: string[] = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (/^[A-Za-z0-9_-]+:/.test(line)) break;
      if (line.startsWith("- ")) {
        tags.push(line.slice(2).trim().replace(/^["']|["']$/g, ""));
      } else {
        break;
      }
    }
    const out: VaultProjectFrontmatter = { tags: tags.filter(Boolean) };
    if (status) out.status = status;
    return out;
  }

  const out: VaultProjectFrontmatter = { tags: [] };
  if (status) out.status = status;
  return out;
}

function getProjectFrontmatter(workspaceRoot: string, projectName: string): VaultProjectFrontmatter | null {
  const slug = slugify(projectName);
  if (projectFrontmatterCache?.workspaceRoot === workspaceRoot && projectFrontmatterCache.bySlug.has(slug)) {
    return projectFrontmatterCache.bySlug.get(slug) ?? null;
  }

  const filePath = join(workspaceRoot, "projects", `${slug}.md`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf8");
    const fm = parseFrontmatter(content);
    const value: VaultProjectFrontmatter = fm ?? { tags: [] };

    if (!projectFrontmatterCache || projectFrontmatterCache.workspaceRoot !== workspaceRoot) {
      projectFrontmatterCache = { workspaceRoot, bySlug: new Map() };
    }
    projectFrontmatterCache.bySlug.set(slug, value);
    return value;
  } catch {
    return null;
  }
}

function mapProjectStatusToLinearIssueStateType(vaultStatus?: string | null): string | null {
  if (!vaultStatus) return null;
  const s = vaultStatus.trim().toLowerCase();
  if (s === "complete" || s === "completed") return "completed";
  if (s === "archived" || s === "canceled" || s === "cancelled") return "cancelled";
  if (s === "paused" || s === "pending" || s === "active" || s === "in-progress" || s === "in progress") return "unstarted";
  return null;
}

function buildAutoRouteComment(issue: LinearUnassignedIssue, route: { team: string | null; project: string | null; reason: string }): string {
  return [
    "AI Note Router auto-route",
    "",
    `Linear Issue: ${issue.identifier}`,
    `Route: ${route.team || "unassigned"} / ${route.project || "unassigned"}`,
    `Reason: ${route.reason}`,
    "",
    "Notes:",
    issue.description ? issue.description.slice(0, 400) : "No description available.",
  ].join("\n");
}

async function runOnce(options: {
  workspaceRoot: string;
  config: RouterConfig;
  apiKey: string;
  dryRun: boolean;
  limit: number;
}) {
  const client = new LinearClient(options.apiKey);
  const viewerId = await client.getViewerId();
  const vaultPeople = getVaultPeople(options.workspaceRoot);
  const vaultProjects = getVaultProjects(options.workspaceRoot);
  const linearTeams = await client.listTeams();
  const linearTeamNameSlugs = new Set(linearTeams.map((t) => normalizeLabelName(t.name)));
  const routeOverrides = loadLinearRouteOverrides(options.workspaceRoot);

  const issues = await client.fetchOpenUnassignedIssues(options.limit);
  logAudit({
    timestamp: new Date().toISOString(),
    stage: "linear-unassigned",
    message: "Fetched open unassigned Linear issues",
    payload: { count: issues.length, limit: options.limit },
  });

  for (const issue of issues) {
    const issueText = `${issue.title}\n${issue.description ?? ""}`;
    const assignedNames = extractAssignedPersonNames(issueText);
    const extractedPeople = extractVaultPeopleFromText(issueText, vaultPeople);
    const assignedFull = new Set(assignedNames.map((n) => normalizePersonNameLower(n)));
    const assignedLast = new Set(assignedNames.map((n) => lastNameLowerFromFullName(normalizePersonNameLower(n))));
    // Prefer explicitly assigned people when present; otherwise use any vault people mentioned in the issue.
    const assignedPersonCards = extractedPeople.filter(
      (card) => assignedFull.has(card.nameLower) || assignedLast.has(card.lastNameLower)
    );
    const routingPersonCards = assignedPersonCards.length > 0 ? assignedPersonCards : extractedPeople;

    let route: { team: string | null; project: string | null; reason: string };

    const override = routeOverrides[issue.identifier];
    if (override) {
      route = { team: override.team, project: override.project, reason: "linear_route_override" };
    } else {
      const note: CanonicalNote = {
        source: { source: "obsidian", url: "linear://issue", externalId: issue.identifier },
        title: issue.title,
        body: issue.description ?? "",
        people: routingPersonCards.map((p) => ({ name: p.name })),
        tasks: [],
        confidence: 1,
        tags: [],
        authority: { source: options.config.default_authority },
      };

      let inferred = inferRouteFromVaultParticipants(
        options.workspaceRoot,
        note,
        options.config,
        resolveRouting(note, options.config, options.workspaceRoot)
      );
      const routeFromProjects = inferRouteFromProjectTitleMentions(issueText, vaultProjects, options.config);
      if (routeFromProjects.team && routeFromProjects.project) {
        inferred = routeFromProjects;
      } else if (!inferred.team || !inferred.project) {
        inferred = routeFromProjects;
      }
      route = inferred;
    }

    const canMoveToTeamProject = Boolean(route.team && route.project);
    if (!canMoveToTeamProject) {
      // Route to viewer for review: assign and comment so you can set team/project and add rules.
      const reviewReason = route.reason || "Could not infer team/project from issue context.";
      if (options.dryRun) {
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Dry-run: would assign issue to you for review (could not infer team/project)",
          payload: { identifier: issue.identifier, route, reason: reviewReason },
        });
        continue;
      }
      try {
        await client.updateIssueFields({
          issueId: issue.id,
          assigneeId: viewerId,
        });
        const reviewComment = [
          "AI Note Router — Needs review",
          "",
          `Linear Issue: ${issue.identifier}`,
          `Reason: ${reviewReason}`,
          "",
          "Please set the correct Team and Project in Linear. You can then add rules in Obsidian (e.g. project note Route block or `config/linear-route-overrides.json`) so future issues route correctly.",
          "",
          "Issue context:",
          issue.description ? issue.description.slice(0, 500) : "(no description)",
        ].join("\n");
        await client.addComment(issue.id, reviewComment);
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Assigned issue to you for review (could not infer team/project)",
          payload: { identifier: issue.identifier, route },
        });
      } catch (err) {
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Failed to assign issue for review",
          payload: { identifier: issue.identifier, error: err instanceof Error ? err.message : String(err) },
        });
      }
      continue;
    }

    const targetIds = await client.resolveTargetIds(route.team, route.project);
    if (!targetIds.teamId || !targetIds.projectId) {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-unassigned",
        message: "Skipping issue (team/project ids not resolved)",
        payload: { identifier: issue.identifier, targetIds },
      });
      continue;
    }

    const projectFm = route.project ? getProjectFrontmatter(options.workspaceRoot, route.project) : null;
    const desiredStateType = mapProjectStatusToLinearIssueStateType(projectFm?.status ?? undefined);

    let desiredStateId: string | null = null;
    if (desiredStateType) {
      desiredStateId = await client.resolveWorkflowStateId(targetIds.teamId, desiredStateType);
    }

    // Always keep the issue "moving" by using todo/unstarted as fallback.
    if (!desiredStateId) {
      desiredStateId = await client.getTodoStateId(targetIds.teamId);
    }

    const desiredTagsRaw = projectFm?.tags ?? [];
    // Treat the first tag as often used as a team key (e.g. `epsilon-group`) and avoid
    // attempting to apply it as an issue label when it matches the resolved team.
    const teamSlug = route.team ? normalizeLabelName(route.team) : null;
    const desiredTags = teamSlug
      ? desiredTagsRaw.filter((t) => normalizeLabelName(t) !== teamSlug)
      : desiredTagsRaw;

    // If a vault tag matches any Linear team name, treat it as metadata (not an issue label).
    // Example: vault tags like `my-company` should not become labels when routing into `Zeta Health`.
    const filteredTags = desiredTags.filter((t) => !linearTeamNameSlugs.has(normalizeLabelName(t)));
    let labelIds: string[] | undefined = undefined;
    if (filteredTags.length > 0) {
      try {
        const labels = await client.listTeamLabels(targetIds.teamId);
        const byName = new Map<string, string>();
        for (const l of labels) byName.set(normalizeLabelName(l.name), l.id);

        const matchedLabelIds: string[] = [];

        for (const rawTag of filteredTags) {
          const tag = rawTag.trim();
          if (!tag) continue;
          const slug = normalizeLabelName(tag);
          const existingId = byName.get(slug);
          if (existingId) {
            matchedLabelIds.push(existingId);
            continue;
          }

          const displayName = labelDisplayNameFromVaultTag(tag);
          if (options.dryRun) {
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "linear-unassigned",
              message: "Dry-run: would create missing Linear label",
              payload: { identifier: issue.identifier, teamId: targetIds.teamId, label: displayName, vaultTag: tag },
            });
            continue;
          }

          const created = await client.createIssueLabel({ teamId: targetIds.teamId, name: displayName });
          byName.set(slug, created.id);
          matchedLabelIds.push(created.id);
        }

        if (matchedLabelIds.length > 0) labelIds = matchedLabelIds;
      } catch (err) {
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Label resolution failed; continuing without labelIds",
          payload: { identifier: issue.identifier, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    const updateInput = {
      issueId: issue.id,
      teamId: targetIds.teamId,
      projectId: targetIds.projectId,
      stateId: desiredStateId ?? undefined,
      assigneeId: viewerId,
      ...(labelIds ? { labelIds } : {}),
    };

    if (options.dryRun) {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-unassigned",
        message: "Dry-run: would auto-route Linear issue",
        payload: { identifier: issue.identifier, route, updateInput: { ...updateInput, assigneeId: "<viewerId>" } },
      });
      continue;
    }

    try {
      const updated = await client.updateIssueFields(updateInput);
      await client.addComment(issue.id, buildAutoRouteComment(issue, route));
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-unassigned",
        message: "Auto-routed Linear issue",
        payload: { identifier: updated.identifier, route },
      });
    } catch (err) {
      // Move (teamId/projectId) may fail e.g. due to permissions or workspace settings.
      // Fallback: assign to viewer only so the issue is no longer unassigned, and comment with suggested route for manual move.
      const firstError = err instanceof Error ? err.message : String(err);
      try {
        await client.updateIssueFields({
          issueId: issue.id,
          assigneeId: viewerId,
        });
        const manualMoveComment = [
          "AI Note Router — could not move automatically",
          "",
          `Suggested route: **${route.team}** / **${route.project}**`,
          `Reason: ${route.reason}`,
          "",
          "Please move this issue to the correct team/project (e.g. Cmd+Shift+M in Linear), then add rules in Obsidian if needed.",
          "",
          "Original error: " + firstError.slice(0, 200),
        ].join("\n");
        await client.addComment(issue.id, manualMoveComment);
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Assigned issue; move failed (suggested route in comment)",
          payload: { identifier: issue.identifier, route, error: firstError.slice(0, 150) },
        });
      } catch (err2) {
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "linear-unassigned",
          message: "Failed to auto-route or assign issue",
          payload: { identifier: issue.identifier, error: firstError.slice(0, 150), assignError: err2 instanceof Error ? err2.message : String(err2) },
        });
      }
    }
  }
}

export function startLinearUnassignedRouter(options: {
  workspaceRoot: string;
  config: RouterConfig;
  apiKey: string;
  dryRun: boolean;
  intervalMs: number;
  limit: number;
}): void {
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runOnce(options);
    } catch (err) {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-unassigned",
        message: "Linear unassigned router tick failed",
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    } finally {
      inFlight = false;
    }
  };

  // Initial run.
  void tick();

  // Periodic run.
  setInterval(() => {
    void tick();
  }, options.intervalMs);
}

