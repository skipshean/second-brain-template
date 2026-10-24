import { existsSync, readdirSync } from "fs";
import { loadProcessedState } from "./processed.js";

const INBOX_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d-]+Z-(?<source>[a-z]+)-(?<id>.+)\.json$/;

export function ingestFingerprint(source: string, id: string): string {
  return `${source}:${id}`;
}

/**
 * Fingerprints the router already knows about: processed, permanently skipped,
 * or still waiting in the inbox. Re-queueing any of these only burns Linear
 * requests, so ingest paths (webhooks, Fireflies backfill) consult this first.
 */
export function loadKnownFingerprints(options: { statePath: string; inboxDir: string }): Set<string> {
  const known = new Set<string>();
  const state = loadProcessedState(options.statePath);
  for (const fingerprint of state.processedFingerprints) known.add(fingerprint);
  for (const entry of state.skippedFingerprints) known.add(entry.fingerprint);

  if (existsSync(options.inboxDir)) {
    for (const file of readdirSync(options.inboxDir)) {
      const match = INBOX_FILE_PATTERN.exec(file);
      const source = match?.groups?.source;
      const id = match?.groups?.id;
      if (source && id) known.add(ingestFingerprint(source, id));
    }
  }

  return known;
}

export function isKnownIngest(known: Set<string>, source: string, id: string): boolean {
  return known.has(ingestFingerprint(source, id));
}
