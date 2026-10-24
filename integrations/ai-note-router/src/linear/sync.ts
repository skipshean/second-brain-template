import type { CanonicalNote } from "../normalize/note.js";

export type LinearSyncResult = {
  action: "create" | "update" | "skip";
  issueId?: string;
  title: string;
  description: string;
  reason: string;
};

export function buildLinearSyncPlan(
  note: CanonicalNote,
  canonicalIssueId?: string,
  description = ""
): LinearSyncResult {
  const title = note.project || note.client || note.title;

  if (canonicalIssueId) {
    return {
      action: "update",
      issueId: canonicalIssueId,
      title,
      description,
      reason: `Update existing canonical issue for ${note.project || note.client || note.title}.`,
    };
  }

  return {
    action: "create",
    title,
    description,
    reason: `Create new Linear issue for ${note.project || note.client || note.title}.`,
  };
}
