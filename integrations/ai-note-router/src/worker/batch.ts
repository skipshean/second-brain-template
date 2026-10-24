import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { RouterConfig } from "../config/types.js";
import type { ProcessingResult } from "./process.js";
import { loadProcessedState } from "../state/processed.js";
import type { CanonicalNote } from "../normalize/note.js";
import { getNoteFingerprint } from "../normalize/fingerprint.js";
import { writeVaultNote } from "../vault/write.js";

export type BatchRunResult = {
  processed: Array<{
    inputPath: string;
    fingerprint: string;
    result: ProcessingResult;
    outputPath: string;
  }>;
  skipped: string[];
  processedFingerprints: string[];
};

export async function runInboxBatch(
  workspaceRoot: string,
  inboxDir: string,
  statePath: string,
  config: RouterConfig,
  dryRun: boolean,
  loadFn: (inputPath: string) => Promise<CanonicalNote>,
  processFn: (note: CanonicalNote, config: RouterConfig, workspaceRoot: string) => Promise<ProcessingResult>
): Promise<BatchRunResult> {
  const processedState = loadProcessedState(statePath);
  const processedSet = new Set(processedState.processedFingerprints);
  const processed: BatchRunResult["processed"] = [];
  const skipped: string[] = [];

  if (!existsSync(inboxDir)) {
    return { processed, skipped, processedFingerprints: Array.from(processedSet) };
  }

  const files = readdirSync(inboxDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(inboxDir, file))
    .sort();

  for (const inputPath of files) {
    const note = await loadFn(inputPath);
    const fingerprint = getNoteFingerprint(note);

    if (processedSet.has(fingerprint)) {
      skipped.push(inputPath);
      continue;
    }

    const result = await processFn(note, config, workspaceRoot);
    const written = dryRun
      ? { filePath: join(workspaceRoot, result.vault.filePath) }
      : writeVaultNote(workspaceRoot, result.vault);
    processed.push({
      inputPath,
      fingerprint,
      result,
      outputPath: written.filePath,
    });

    processedSet.add(fingerprint);
  }

  return { processed, skipped, processedFingerprints: Array.from(processedSet) };
}
