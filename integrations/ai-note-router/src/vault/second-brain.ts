import type { CanonicalNote } from "../normalize/note.js";
import type { ResolvedRoute } from "../resolve/routing.js";

export type VaultWriteResult = {
  filePath: string;
  updated: boolean;
  summary: string;
};

export function buildVaultNote(
  note: CanonicalNote,
  canonicalIssueId?: string,
  route?: ResolvedRoute
): VaultWriteResult {
  const slug = (note.project || note.client || note.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const filePath = `outputs/ai-note-router/${slug}.md`;
  const summary = [
    `# ${note.project || note.client || note.title}`,
    "",
    `## Source`,
    `- ${note.source.source}: ${note.source.url}`,
    note.source.externalId ? `- Source ID: ${note.source.externalId}` : null,
    note.source.capturedAt ? `- Captured: ${note.source.capturedAt}` : null,
    "",
    `## Routing`,
    route ? `- Team: ${route.team || "unassigned"}` : "- Team: unassigned",
    route ? `- Project: ${route.project || "unassigned"}` : "- Project: unassigned",
    route ? `- Reason: ${route.reason}` : "- Reason: unavailable",
    "",
    `## Canonical Linear Issue`,
    canonicalIssueId ? `- ${canonicalIssueId}` : "- Not linked yet",
    "",
    `## Summary`,
    `- ${note.body.slice(0, 500)}`,
  ].filter((line): line is string => line !== null).join("\n");

  return {
    filePath,
    updated: false,
    summary,
  };
}
