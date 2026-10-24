import type { CanonicalTaskCandidate } from "../normalize/note.js";

type FirefliesTaskTranscript = {
  summary?: {
    action_items?: string | null;
  } | null;
  sentences?: Array<{
    speaker_name?: string | null;
    text?: string | null;
    raw_text?: string | null;
    start_time?: string | null;
    ai_filters?: {
      task?: boolean | null;
    } | null;
  }> | null;
};

export function extractTasksFromFirefliesTranscript(
  transcript: FirefliesTaskTranscript
): CanonicalTaskCandidate[] {
  const extracted: CanonicalTaskCandidate[] = [];
  const seen = new Set<string>();

  const summaryActionItems = (transcript.summary?.action_items ?? "").trim();
  if (summaryActionItems) {
    const lines = summaryActionItems
      .split(/\r?\n+/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const parsed = parseTaskLine(line);
      if (!parsed.title) continue;
      const key = normalizeKey(parsed.title, parsed.assigneeName ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push({
        title: parsed.title,
        confidence: 0.9,
        ...(parsed.assigneeName ? { assigneeName: parsed.assigneeName } : {}),
        sourceQuote: line,
      });
    }
  }

  if (!summaryActionItems) {
    const sentences = transcript.sentences ?? [];
    for (const sentence of sentences) {
      if (sentence.ai_filters?.task !== true) continue;
      const raw = (sentence.text ?? sentence.raw_text ?? "").trim();
      if (!raw) continue;
      const speaker = (sentence.speaker_name ?? "").trim();
      const key = normalizeKey(raw, speaker || null);
      if (seen.has(key)) continue;
      seen.add(key);
      extracted.push({
        title: raw,
        confidence: 0.75,
        ...(speaker ? { assigneeName: speaker, sourceSpeaker: speaker } : {}),
        ...(sentence.start_time ? { sourceTimestamp: sentence.start_time } : {}),
        sourceQuote: raw,
      });
    }
  }

  return extracted;
}

function parseTaskLine(line: string): { title: string; assigneeName?: string } {
  // Common generated format: "Name: task text"
  const withOwner = line.match(/^([^:]{2,60}):\s+(.+)$/);
  if (withOwner) {
    const assigneeName = withOwner[1]?.trim() ?? "";
    const title = withOwner[2]?.trim() ?? "";
    if (assigneeName && title) {
      return { title, assigneeName };
    }
  }
  return { title: line.trim() };
}

function normalizeKey(title: string, assignee: string | null): string {
  return `${title.toLowerCase().replace(/\s+/g, " ").trim()}::${(assignee ?? "").toLowerCase().trim()}`;
}
