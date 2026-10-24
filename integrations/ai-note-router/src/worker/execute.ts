import type { RouterConfig } from "../config/types.js";
import type { CanonicalNote } from "../normalize/note.js";
import { getNoteFingerprint } from "../normalize/fingerprint.js";
import { processNote } from "./process.js";
import { writeVaultNote } from "../vault/write.js";
import { upsertProjectNote } from "../vault/upsert.js";
import { LinearClient } from "../clients/linear.js";
import { applyLinearSync } from "../linear/apply.js";
import type { LinearIssueCandidate } from "../resolve/dedupe.js";
import { notifyTaskEvents } from "../notify/slack.js";

export type ExecuteNoteOptions = {
  workspaceRoot: string;
  dryRun: boolean;
  apiKey?: string;
};

export type ExecuteNoteResult = {
  fingerprint: string;
  result: ReturnType<typeof processNote>;
  written?: { filePath: string };
  projectNote?: { filePath: string; created: boolean; updated: boolean };
  linearResult?: {
    action: "create" | "update" | "skip";
    reason: string;
    issueId?: string;
    identifier?: string;
    title?: string;
  };
};

export async function executeNote(
  note: CanonicalNote,
  config: RouterConfig,
  options: ExecuteNoteOptions,
  candidates: LinearIssueCandidate[] = []
): Promise<ExecuteNoteResult> {
  const fingerprint = getNoteFingerprint(note);
  const loadedCandidates =
    candidates.length > 0
      ? candidates
      : options.apiKey && config.dedupe.enabled
        ? await new LinearClient(options.apiKey).searchOpenIssueCandidates(note.team ?? null, note.project ?? null, note)
        : [];
  const result = processNote(note, config, loadedCandidates, options.workspaceRoot);

  if (options.dryRun) {
    return { fingerprint, result };
  }

  const written = writeVaultNote(options.workspaceRoot, result.vault);
  const projectNote = upsertProjectNote(options.workspaceRoot, result.note, result.route, result.dedupe.canonicalIssueId);

  let linearResult: ExecuteNoteResult["linearResult"];
  if (options.apiKey) {
    const client = new LinearClient(options.apiKey);
    linearResult = await applyLinearSync(client, result.note, result.route, result.linear);
  } else {
    linearResult = { action: "skip", reason: "Skipping Linear write because LINEAR_API_KEY is not set." };
  }

  await notifyTaskEvents({
    workspaceRoot: options.workspaceRoot,
    config,
    note: result.note,
    obsidianCreatedTaskTitles: projectNote.createdTaskTitles ?? [],
    linearResult,
  });

  return {
    fingerprint,
    result,
    written,
    projectNote,
    linearResult,
  };
}
