import type { CanonicalNote } from "../normalize/note.js";
import type { ResolvedRoute } from "../resolve/routing.js";
import type { LinearSyncResult } from "./sync.js";
import { LinearClient } from "../clients/linear.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeLabelName(name: string): string {
  return slugify(name);
}

function labelDisplayNameFromVaultTag(tag: string): string {
  const cleaned = tag.trim();
  if (!cleaned) return cleaned;
  const withSpaces = cleaned.replace(/[-_]+/g, " ");
  return withSpaces
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
      const parts = raw
        .split(/,| and | & /gi)
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

      for (const part of parts) {
        if (/[A-Za-z]/.test(part) && part.split(/\s+/).filter(Boolean).length >= 2) {
          out.push(part);
        }
      }
    }
  }

  return Array.from(new Set(out));
}

function extractAssignedPersonNamesFromTasks(note: CanonicalNote): string[] {
  const out: string[] = [];
  for (const task of note.tasks) {
    const name = (task.assigneeName ?? "").trim();
    if (!name) continue;
    if (!/[A-Za-z]/.test(name)) continue;
    if (name.split(/\s+/).filter(Boolean).length < 2) continue;
    out.push(name);
  }
  return Array.from(new Set(out));
}

export type LinearApplyResult = {
  action: "create" | "update" | "skip";
  issueId?: string;
  identifier?: string;
  title?: string;
  reason: string;
};

export async function applyLinearSync(
  client: LinearClient,
  note: CanonicalNote,
  route: ResolvedRoute,
  plan: LinearSyncResult
): Promise<LinearApplyResult> {
  if (plan.action === "skip") {
    return {
      action: "skip",
      reason: plan.reason,
    };
  }

  if (!route.team) {
    return {
      action: "skip",
      reason: "Skipping Linear write because no team could be resolved.",
    };
  }

  // Your rule: only write to Linear if the transcript contains an assignment signal.
  const assignedNames = Array.from(
    new Set([...extractAssignedPersonNames(note.body), ...extractAssignedPersonNamesFromTasks(note)])
  );
  if (assignedNames.length === 0) {
    return {
      action: "skip",
      reason: "Skipping Linear write because no assignee signal was detected in the transcript text.",
    };
  }

  const targetIds = await client.resolveTargetIds(route.team, route.project);
  if (!targetIds.teamId) {
    return {
      action: "skip",
      reason: `Skipping Linear write because team '${route.team}' could not be resolved.`,
    };
  }

  const viewerId = await client.getViewerId();
  const todoStateId = await client.getTodoStateId(targetIds.teamId);

  // Best-effort label mapping from note.tags -> Linear labels.
  let labelIds: string[] | undefined = undefined;
  if (note.tags.length > 0) {
    try {
      const labels = await client.listTeamLabels(targetIds.teamId);
      const byName = new Map<string, string>();
      for (const l of labels) byName.set(normalizeLabelName(l.name), l.id);

      const teamSlug = route.team ? normalizeLabelName(route.team) : null;
      const desiredTags = teamSlug ? note.tags.filter((t) => normalizeLabelName(t) !== teamSlug) : note.tags;

      const matchedLabelIds: string[] = [];
      for (const rawTag of desiredTags) {
        const tag = rawTag.trim();
        if (!tag) continue;
        const slug = normalizeLabelName(tag);

        const existingId = byName.get(slug);
        if (existingId) {
          matchedLabelIds.push(existingId);
          continue;
        }

        const displayName = labelDisplayNameFromVaultTag(tag);
        const created = await client.createIssueLabel({ teamId: targetIds.teamId, name: displayName });
        byName.set(slug, created.id);
        matchedLabelIds.push(created.id);
      }

      if (matchedLabelIds.length > 0) labelIds = matchedLabelIds;
    } catch {
      // Ignore label resolution failures; assignment+route is more important.
    }
  }

  const comment = buildComment(note, route);

  if (plan.action === "create") {
    const issue = await client.createIssue({
      teamId: targetIds.teamId,
      projectId: targetIds.projectId,
      title: plan.title,
      description: plan.description,
    });

    await client.updateIssueFields({
      issueId: issue.id,
      assigneeId: viewerId,
      stateId: todoStateId,
      ...(labelIds ? { labelIds } : {}),
    });

    await client.addComment(issue.id, comment);

    return {
      action: "create",
      issueId: issue.id,
      identifier: issue.identifier,
      title: plan.title,
      reason: `Created Linear issue ${issue.identifier}`,
    };
  }

  if (!plan.issueId) {
    return {
      action: "skip",
      reason: "Skipping Linear update because no canonical issue ID was provided.",
    };
  }

  const issue = await client.updateIssueFields({
    issueId: plan.issueId,
    title: plan.title,
    description: plan.description,
    teamId: targetIds.teamId,
    stateId: todoStateId,
    assigneeId: viewerId,
    ...(targetIds.projectId ? { projectId: targetIds.projectId } : {}),
    ...(labelIds ? { labelIds } : {}),
  });
  await client.addComment(issue.id, comment);

  return {
    action: "update",
    issueId: issue.id,
    identifier: issue.identifier,
    title: plan.title,
    reason: `Updated Linear issue ${issue.identifier}`,
  };
}

function buildComment(note: CanonicalNote, route: ResolvedRoute): string {
  const lines = [
    "AI note router update",
    "",
    `Source: ${note.source.source} ${note.source.url}`,
    note.source.externalId ? `Source ID: ${note.source.externalId}` : null,
    note.source.capturedAt ? `Captured: ${note.source.capturedAt}` : null,
    `Route: ${route.team || "unassigned"} / ${route.project || "unassigned"}`,
    "",
    "Summary:",
    note.body.slice(0, 500),
  ];

  return lines.filter((line): line is string => line !== null).join("\n");
}
