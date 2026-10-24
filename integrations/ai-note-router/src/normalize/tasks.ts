import type { CanonicalPerson, CanonicalTaskCandidate } from "./note.js";
import { extractCuratedActions } from "./curated-items.js";
import { classifyOwnerGroup } from "./owner-groups.js";
import type { RouterConfig } from "../config/types.js";

type ExtractorConfig = RouterConfig["extractor"];

/** Minimal typing for Node 22+ built-in Temporal (not in default TS lib). */
type TemporalPlainDate = {
  dayOfWeek: number;
  add(input: { days: number }): TemporalPlainDate;
  subtract(input: { days: number }): TemporalPlainDate;
  toString(): string;
};

type TemporalGlobal = {
  Instant: {
    from(iso: string): {
      toZonedDateTimeISO(timeZone: string): { toPlainDate(): TemporalPlainDate };
    };
  };
};

function getTemporal(): TemporalGlobal | null {
  const T = (globalThis as { Temporal?: TemporalGlobal }).Temporal;
  return T ?? null;
}

type BuildTaskCandidatesInput = {
  body: string;
  people: CanonicalPerson[];
  tasks: CanonicalTaskCandidate[];
  capturedAt?: string;
  /** IANA timezone for calendar interpretation of relative due phrases (default: env ROUTER_TASK_DUE_TIMEZONE or UTC). */
  timeZone?: string;
  /** Extractor tuning. Falls back to conservative defaults if omitted. */
  extractor?: ExtractorConfig;
};

// Kept in lockstep with `createDefaultConfig()` in ../config/load.ts — both are
// "someone called us without config" fallbacks, and divergent phrase lists would
// cause test callers (which hit this default) to behave differently from
// production (which loads the YAML via createDefaultConfig). If you update one
// you must update the other.
const DEFAULT_EXTRACTOR: ExtractorConfig = {
  max_items: 15,
  curated_mode: "prefer",
  commitment_phrases: [
    "i'll", "i will", "we'll", "we will",
    "send me", "send over", "send you", "get you", "follow up",
    "follow-up", "track down", "confirm", "schedule", "draft",
    "by eow", "by end of week", "by tomorrow", "next week",
  ],
  owner_groups: { self: [], client: [], parking_lot_markers: [] },
};

function resolveTaskDueTimeZone(explicit?: string): string {
  const fromEnv = typeof process !== "undefined" && process.env?.ROUTER_TASK_DUE_TIMEZONE?.trim();
  return (explicit?.trim() || fromEnv || "UTC") || "UTC";
}

export function buildTaskCandidates(input: BuildTaskCandidatesInput): CanonicalTaskCandidate[] {
  const extractor = input.extractor ?? DEFAULT_EXTRACTOR;
  const timeZone = resolveTaskDueTimeZone(input.timeZone);

  // Precedence:
  //   1. tasks explicitly passed in (already curated upstream, e.g. Fireflies action_items)
  //   2. curated section detected in body (Fireflies "Action Items:" / Granola "### Next Steps")
  //   3. heuristic fallback, unless curated_mode === "force"
  let base: CanonicalTaskCandidate[] = [];
  let cameFromCurated = false;

  if ((input.tasks ?? []).length > 0) {
    base = input.tasks;
    cameFromCurated = true;
  } else if (extractor.curated_mode !== "off") {
    const curated = extractCuratedActions(input.body);
    if (curated !== null) {
      base = curated.map((c) => {
        const t: CanonicalTaskCandidate = { title: c.title, confidence: 0.9 };
        if (c.assigneeName) t.assigneeName = c.assigneeName;
        return t;
      });
      cameFromCurated = true;
    } else if (extractor.curated_mode === "force") {
      base = [];
    } else {
      base = inferTasksFromTranscriptBody(input.body, extractor).map(({ title, speaker }) => ({
        title,
        confidence: 0.5,
        ...(speaker ? { sourceSpeaker: speaker } : {}),
      }));
    }
  } else {
    // curated_mode === "off": always run heuristic
    base = inferTasksFromTranscriptBody(input.body, extractor).map(({ title, speaker }) => ({
      title,
      confidence: 0.5,
      ...(speaker ? { sourceSpeaker: speaker } : {}),
    }));
  }

  const cleaned = dedupeTaskCandidates(
    base
      .map((task) => ({ ...task, title: task.title.trim() }))
      .filter((task) => task.title.length > 0)
      // Trust curated sources — only the heuristic path runs the chatter filter.
      .filter((task) => cameFromCurated || !isLikelyConversationLine(task.title))
  );

  const enriched = cleaned.map((task) =>
    enrichTask(task, input.people, input.capturedAt ?? null, timeZone)
  );
  const grouped = enriched.map((task) => ({
    ...task,
    ownerGroup: classifyOwnerGroup(task, extractor),
  }));

  // Cap only applies when we fell back to the heuristic; curated content is trusted.
  if (!cameFromCurated) {
    return grouped.slice(0, extractor.max_items);
  }
  return grouped;
}

type HeuristicTask = { title: string; speaker: string | null };

function inferTasksFromTranscriptBody(body: string, extractor: ExtractorConfig): HeuristicTask[] {
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const phrases = extractor.commitment_phrases.map((p) => p.toLowerCase());
  const tasks: HeuristicTask[] = [];
  let inActionItemsSection = false;
  let inTranscriptSection = false;

  for (const line of lines) {
    const cleaned = line.replace(/^[-*]\s+/, "").trim();
    if (!cleaned) continue;

    if (/^action items?:?$/i.test(cleaned)) { inActionItemsSection = true; continue; }
    if (/^summary:?$/i.test(cleaned)) { inActionItemsSection = false; continue; }
    if (/^transcript:?$/i.test(cleaned)) { inActionItemsSection = false; inTranscriptSection = true; continue; }
    if (/^---+$/.test(cleaned)) continue;

    const speakerMatch =
      inActionItemsSection && !inTranscriptSection ? null : matchSpeakerPrefix(cleaned);
    const candidate = speakerMatch?.text ?? cleaned;
    const speaker = speakerMatch?.speaker ?? null;
    const candidateLower = candidate.toLowerCase();

    if (isLikelyConversationLine(candidate)) continue;

    const hasCommitment = phrases.some((p) => candidateLower.includes(p));
    const hasDateRef =
      /\b20\d{2}-\d{2}-\d{2}\b/.test(candidateLower) ||
      /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(candidateLower) ||
      /\bby\s+eow\b/.test(candidateLower) ||
      /\bend of (the )?week\b/.test(candidateLower) ||
      /\bby\s+tomorrow\b/.test(candidateLower) ||
      /\bnext week\b/.test(candidateLower);

    if (!inActionItemsSection && !hasCommitment && !hasDateRef) continue;

    tasks.push({ title: candidate, speaker });
  }

  return dedupeHeuristicTasks(tasks);
}

function matchSpeakerPrefix(line: string): { speaker: string; text: string } | null {
  const m = line.match(/^([A-Za-z][A-Za-z0-9.' -]{1,40}):\s+(.+)$/);
  if (!m?.[2]) return null;
  return { speaker: (m[1] ?? "").trim(), text: m[2].trim() };
}

function dedupeTaskCandidates(values: CanonicalTaskCandidate[]): CanonicalTaskCandidate[] {
  const out: CanonicalTaskCandidate[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalize(value.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function isLikelyConversationLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (line.length > 220) return true;
  if (/^(yes|yeah|yep|no|okay|ok|right|sure|great)\.?$/i.test(line)) return true;
  if (/[?]$/.test(line)) return true;
  // Avoid obvious transcript chatter becoming tasks. Commitment/date filtering
  // in the heuristic pre-filter handles the "but it's also a real task" case.
  return /\b(you know|i mean|gotcha|makes sense)\b/.test(lower);
}

function enrichTask(
  task: CanonicalTaskCandidate,
  people: CanonicalPerson[],
  capturedAt: string | null,
  timeZone: string
): CanonicalTaskCandidate {
  const explicit = resolveAssignee(task.assigneeName ?? null, people);
  const dueDate = task.dueDate ?? inferDueDate(task.title, capturedAt, timeZone);
  if (explicit) {
    return {
      ...task,
      assigneeName: explicit.name,
      ...(explicit.email ? { assigneeEmail: explicit.email } : {}),
      assigneeConfidence: Math.max(task.assigneeConfidence ?? 0, 0.9),
      ...(dueDate ? { dueDate } : {}),
    };
  }

  const inline = parseInlineAssignee(task.title);
  if (!inline) {
    return {
      ...task,
      ...(dueDate ? { dueDate } : {}),
    };
  }
  const match = resolveAssignee(inline.assigneeHint, people);
  if (!match) {
    return {
      ...task,
      title: inline.title,
      ...(dueDate ? { dueDate } : {}),
    };
  }

  return {
    ...task,
    title: inline.title,
    assigneeName: match.name,
    ...(match.email ? { assigneeEmail: match.email } : {}),
    assigneeConfidence: Math.max(task.assigneeConfidence ?? 0, 0.8),
    ...(dueDate ? { dueDate } : {}),
  };
}

function parseInlineAssignee(title: string): { assigneeHint: string; title: string } | null {
  const withOwner = title.match(/^([^:]{2,60}):\s+(.+)$/);
  if (!withOwner) return null;
  const assigneeHint = (withOwner[1] ?? "").trim();
  const rest = (withOwner[2] ?? "").trim();
  if (!assigneeHint || !rest) return null;
  return { assigneeHint, title: rest };
}

function resolveAssignee(nameHint: string | null, people: CanonicalPerson[]): CanonicalPerson | null {
  if (!nameHint) return null;
  const hint = normalize(nameHint);
  if (!hint) return null;

  const exact = people.find((p) => normalize(p.name) === hint);
  if (exact) return exact;

  const byPrefix = people.find((p) => normalize(p.name).startsWith(hint));
  if (byPrefix) return byPrefix;

  const byLastName = people.find((p) => {
    const parts = normalize(p.name).split(" ").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    return last === hint;
  });
  if (byLastName) return byLastName;

  return null;
}

function dedupeHeuristicTasks(values: HeuristicTask[]): HeuristicTask[] {
  const out: HeuristicTask[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const k = normalize(value.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function inferDueDate(title: string, capturedAt: string | null, timeZone: string): string | undefined {
  const isoMatch = title.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch?.[1]) return isoMatch[1];

  const lower = title.toLowerCase();
  const refIso = capturedAt && !Number.isNaN(Date.parse(capturedAt)) ? capturedAt : new Date().toISOString();

  if (/\b(by\s+)?tomorrow\b/.test(lower)) {
    return addCalendarDaysInZone(refIso, timeZone, 1);
  }

  if (/\b(by\s+)?eow\b/.test(lower) || /\b(by\s+)?end of (the )?week\b/.test(lower)) {
    return nextOrSameFridayInZone(refIso, timeZone);
  }

  if (/\bnext week\b/.test(lower)) {
    return mondayOfNextCalendarWeekInZone(refIso, timeZone);
  }

  const weekdayMatch = title.match(/\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (!weekdayMatch?.[1]) return undefined;

  const weekdayIdx = weekdayToIndex(weekdayMatch[1]);
  if (weekdayIdx < 0) return undefined;

  if (timeZone === "UTC" || !hasTemporal()) {
    const base = new Date(refIso);
    if (Number.isNaN(base.getTime())) return undefined;
    const baseDay = base.getUTCDay();
    let delta = (weekdayIdx - baseDay + 7) % 7;
    if (delta === 0) delta = 7;

    const out = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
    out.setUTCDate(out.getUTCDate() + delta);
    return `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`;
  }

  return nextWeekdayOnOrAfterRefInZone(refIso, timeZone, weekdayIdx);
}

function hasTemporal(): boolean {
  return getTemporal() !== null;
}

/** Add N whole calendar days in `timeZone` from the calendar day containing `refIso`. */
function addCalendarDaysInZone(refIso: string, timeZone: string, days: number): string | undefined {
  if (hasTemporal()) {
    try {
      const TemporalNs = getTemporal();
      if (!TemporalNs) throw new Error("no Temporal");
      const inst = TemporalNs.Instant.from(refIso);
      const zdt = inst.toZonedDateTimeISO(timeZone);
      const next = zdt.toPlainDate().add({ days });
      return next.toString();
    } catch {
      return undefined;
    }
  }
  const base = new Date(refIso);
  if (Number.isNaN(base.getTime())) return undefined;
  const u = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days);
  const x = new Date(u);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
}

/** Next Friday on or after the reference calendar date in `timeZone` (Mon–Fri business week anchor). */
function nextOrSameFridayInZone(refIso: string, timeZone: string): string | undefined {
  if (!hasTemporal()) {
    return nextOrSameFridayUtc(refIso);
  }
  try {
    const TemporalNs = getTemporal();
    if (!TemporalNs) throw new Error("no Temporal");
    const inst = TemporalNs.Instant.from(refIso);
    const zdt = inst.toZonedDateTimeISO(timeZone);
    const pd = zdt.toPlainDate();
    const dow = pd.dayOfWeek;
    const delta = (5 - dow + 7) % 7;
    return pd.add({ days: delta }).toString();
  } catch {
    return nextOrSameFridayUtc(refIso);
  }
}

function nextOrSameFridayUtc(refIso: string): string | undefined {
  const base = new Date(refIso);
  if (Number.isNaN(base.getTime())) return undefined;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();
  const dow = base.getUTCDay();
  const delta = (5 - dow + 7) % 7;
  const out = new Date(Date.UTC(y, m, d + delta));
  return `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`;
}

/** Monday of the calendar week immediately after the week containing `refIso` in `timeZone` (weeks start Monday). */
function mondayOfNextCalendarWeekInZone(refIso: string, timeZone: string): string | undefined {
  if (!hasTemporal()) {
    return mondayOfNextWeekUtc(refIso);
  }
  try {
    const TemporalNs = getTemporal();
    if (!TemporalNs) throw new Error("no Temporal");
    const inst = TemporalNs.Instant.from(refIso);
    const zdt = inst.toZonedDateTimeISO(timeZone);
    const pd = zdt.toPlainDate();
    const dow = pd.dayOfWeek;
    const mondayThisWeek = pd.subtract({ days: dow - 1 });
    return mondayThisWeek.add({ days: 7 }).toString();
  } catch {
    return mondayOfNextWeekUtc(refIso);
  }
}

function mondayOfNextWeekUtc(refIso: string): string | undefined {
  const base = new Date(refIso);
  if (Number.isNaN(base.getTime())) return undefined;
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();
  const dow = base.getUTCDay();
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  const mondayThisWeek = new Date(Date.UTC(y, m, d - mondayOffset));
  mondayThisWeek.setUTCDate(mondayThisWeek.getUTCDate() + 7);
  return `${mondayThisWeek.getUTCFullYear()}-${pad2(mondayThisWeek.getUTCMonth() + 1)}-${pad2(mondayThisWeek.getUTCDate())}`;
}

/**
 * Next occurrence of weekday in `timeZone` (weekdayIdx: 0=Sun..6=Sat, same as getUTCDay).
 * If ref day already matches target weekday, returns +7 days (matches prior "by Friday" UTC behavior).
 */
function nextWeekdayOnOrAfterRefInZone(refIso: string, timeZone: string, weekdayIdx: number): string | undefined {
  try {
    const TemporalNs = getTemporal();
    if (!TemporalNs) return undefined;
    const inst = TemporalNs.Instant.from(refIso);
    const zdt = inst.toZonedDateTimeISO(timeZone);
    const pd = zdt.toPlainDate();
    const currentJs = pd.dayOfWeek === 7 ? 0 : pd.dayOfWeek;
    let delta = (weekdayIdx - currentJs + 7) % 7;
    if (delta === 0) delta = 7;
    return pd.add({ days: delta }).toString();
  } catch {
    return undefined;
  }
}

function weekdayToIndex(day: string): number {
  switch (day.toLowerCase()) {
    case "sunday":
      return 0;
    case "monday":
      return 1;
    case "tuesday":
      return 2;
    case "wednesday":
      return 3;
    case "thursday":
      return 4;
    case "friday":
      return 5;
    case "saturday":
      return 6;
    default:
      return -1;
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
