import type { CanonicalNote } from "./note.js";

export function getNoteFingerprint(note: CanonicalNote): string {
  const sourceId = note.source.externalId || note.source.url;
  return `${note.source.source}:${sourceId}`;
}
