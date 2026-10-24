import type { CanonicalTaskCandidate } from "./note.js";
import type { RouterConfig } from "../config/types.js";

type Extractor = RouterConfig["extractor"];

// Granola labels the note-taker's own audio as "Microphone" in transcripts, so a
// commitment spoken by the note-taker with no explicit assignee is theirs.
const SELF_SPEAKER_LABELS = ["microphone"];

function isSelfLabel(label: string, config: Extractor): boolean {
  const norm = label.trim().toLowerCase();
  if (!norm) return false;
  if (SELF_SPEAKER_LABELS.includes(norm)) return true;
  return config.owner_groups.self.some((n) => norm === n.trim().toLowerCase());
}

export function classifyOwnerGroup(
  task: CanonicalTaskCandidate,
  config: Extractor
): "self" | "client" | "parking_lot" {
  const titleLower = task.title.toLowerCase();
  for (const marker of config.owner_groups.parking_lot_markers) {
    if (!marker) continue;
    if (titleLower.includes(marker.toLowerCase())) return "parking_lot";
  }

  const assignee = (task.assigneeName ?? "").trim();
  const speaker = (task.sourceSpeaker ?? "").trim();

  // An explicit assignee wins. Fall back to the transcript speaker only when no
  // assignee was resolved, so "Alex: send the deck" stays with Alex while a
  // line the note-taker speaks about someone else isn't misattributed to self.
  if (isSelfLabel(assignee, config)) return "self";
  if (!assignee) {
    if (isSelfLabel(speaker, config)) return "self";
    return "parking_lot";
  }

  const norm = assignee.toLowerCase();
  if (config.owner_groups.client.some((n) => norm === n.trim().toLowerCase())) return "client";

  return "client";
}
