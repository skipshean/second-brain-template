import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export type SkippedFingerprint = {
  fingerprint: string;
  reason: string;
  skippedAt: string;
  filePath?: string;
};

export type ProcessedState = {
  processedFingerprints: string[];
  /** Payloads that failed permanently (e.g. Linear "Entity is retired") and must never be retried. */
  skippedFingerprints: SkippedFingerprint[];
};

export function loadProcessedState(statePath: string): ProcessedState {
  if (!existsSync(statePath)) {
    return { processedFingerprints: [], skippedFingerprints: [] };
  }

  const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ProcessedState>;
  return {
    processedFingerprints: parsed.processedFingerprints ?? [],
    skippedFingerprints: parsed.skippedFingerprints ?? [],
  };
}

export function saveProcessedState(statePath: string, state: ProcessedState): void {
  const directory = dirname(statePath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}
