import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { logAudit } from "../audit/log.js";
import type { SourceInput } from "../sources/types.js";
import { sanitizeSourceId } from "../server/security.js";

type GranolaNoteSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type GranolaNoteDetail = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  summary_markdown: string | null;
  summary_text: string;
  transcript: Array<{
    speaker?: { source?: string; diarization_label?: string; name?: string | null };
    text?: string;
    start_time?: string;
    end_time?: string;
  }> | null;
  attendees: Array<{ name: string | null; email: string }> | null;
  folder_membership: Array<{
    id: string;
    object?: string;
    name: string;
    parent_folder_id?: string | null;
  }> | null;
  calendar_event: {
    event_title: string | null;
    scheduled_start_time: string | null;
  } | null;
};

type GranolaListResponse = {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor: string | null;
};

type GranolaPollerState = {
  lastSeenUpdatedAt: string;
  noteUpdatedAtById: Record<string, string>;
};

export type GranolaApiPollerOptions = {
  workspaceRoot: string;
  dryRun: boolean;
  intervalMinutes: number;
};

const GRANOLA_API_BASE_URL = "https://public-api.granola.ai";
const GRANOLA_DEFAULT_BOOTSTRAP_LOOKBACK_HOURS = 72;
const GRANOLA_LIST_PAGE_SIZE = 30;
const GRANOLA_UPDATED_AFTER_OVERLAP_MS = 2 * 60 * 1000;
const GRANOLA_MAX_TRACKED_NOTES = 2000;

export async function runGranolaApiPollOnce(options: GranolaApiPollerOptions): Promise<void> {
  const apiKey = process.env.GRANOLA_API_KEY?.trim();
  if (!apiKey) {
    return;
  }

  const statePath = join(options.workspaceRoot, "outputs/ai-note-router/granola-api-state.json");
  const state = loadState(statePath);
  const updatedAfter = new Date(Date.parse(state.lastSeenUpdatedAt) - GRANOLA_UPDATED_AFTER_OVERLAP_MS).toISOString();

  const list = await listGranolaNotes(apiKey, updatedAfter);
  if (list.length === 0) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "granola-api",
      message: "Granola API poll found no updated notes.",
      payload: { updatedAfter },
    });
    return;
  }

  let queued = 0;
  let skipped = 0;
  let maxSeenTimestamp = state.lastSeenUpdatedAt;
  for (const note of list) {
    if (!note.id || !note.updated_at) {
      continue;
    }

    if (state.noteUpdatedAtById[note.id] === note.updated_at) {
      skipped += 1;
      continue;
    }

    const detail = await getGranolaNote(apiKey, note.id);
    const payload = toSourceInput(detail);
    if (!options.dryRun) {
      persistInboxPayload(options.workspaceRoot, payload);
    }
    queued += 1;
    state.noteUpdatedAtById[note.id] = note.updated_at;

    if (Date.parse(note.updated_at) > Date.parse(maxSeenTimestamp)) {
      maxSeenTimestamp = note.updated_at;
    }
  }

  state.lastSeenUpdatedAt = maxSeenTimestamp;
  state.noteUpdatedAtById = trimNoteVersionMap(state.noteUpdatedAtById);
  saveState(statePath, state);

  logAudit({
    timestamp: new Date().toISOString(),
    stage: "granola-api",
    message: "Granola API poll completed.",
    payload: {
      listed: list.length,
      queued,
      skipped,
      dryRun: options.dryRun,
      lastSeenUpdatedAt: state.lastSeenUpdatedAt,
    },
  });
}

export function startGranolaApiPoller(options: GranolaApiPollerOptions): void {
  const intervalMs = Math.max(1, options.intervalMinutes) * 60 * 1000;

  void runGranolaApiPollOnce(options).catch((error) => {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "granola-api",
      message: "Granola API initial poll failed.",
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
  });

  setInterval(() => {
    void runGranolaApiPollOnce(options).catch((error) => {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "granola-api",
        message: "Granola API scheduled poll failed.",
        payload: { error: error instanceof Error ? error.message : String(error) },
      });
    });
  }, intervalMs);

  logAudit({
    timestamp: new Date().toISOString(),
    stage: "granola-api",
    message: "Granola API poller started.",
    payload: { intervalMinutes: Math.max(1, options.intervalMinutes) },
  });
}

async function listGranolaNotes(apiKey: string, updatedAfter: string): Promise<GranolaNoteSummary[]> {
  const out: GranolaNoteSummary[] = [];
  let cursor: string | null = null;

  while (true) {
    const query = new URLSearchParams({
      updated_after: updatedAfter,
      page_size: String(GRANOLA_LIST_PAGE_SIZE),
    });
    if (cursor) query.set("cursor", cursor);

    const json = await granolaFetch<GranolaListResponse>(`/v1/notes?${query.toString()}`, apiKey);
    out.push(...(json.notes ?? []));
    if (!json.hasMore || !json.cursor) {
      break;
    }
    cursor = json.cursor;
  }

  return out;
}

async function getGranolaNote(apiKey: string, noteId: string): Promise<GranolaNoteDetail> {
  return granolaFetch<GranolaNoteDetail>(`/v1/notes/${encodeURIComponent(noteId)}?include=transcript`, apiKey);
}

async function granolaFetch<T>(path: string, apiKey: string): Promise<T> {
  const baseUrl = process.env.GRANOLA_API_BASE_URL?.trim() || GRANOLA_API_BASE_URL;
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Granola API request failed (${response.status} ${response.statusText}): ${body.slice(0, 400)}`);
  }

  return response.json() as Promise<T>;
}

function toSourceInput(note: GranolaNoteDetail): SourceInput {
  const people = (note.attendees ?? [])
    .map((p) => {
      const name = p.name?.trim() || p.email.trim();
      return name ? { name, ...(p.email ? { email: p.email } : {}) } : null;
    })
    .filter((p): p is { name: string; email?: string } => Boolean(p));

  const summary = note.summary_markdown?.trim() || note.summary_text?.trim() || "";
  const transcriptLines = (note.transcript ?? [])
    .map((line) => {
      const text = line.text?.trim();
      if (!text) return null;
      // Prefer a diarized/known name; fall back to the raw source label
      // (Granola uses "microphone" for the note-taker's own audio).
      const speaker = line.speaker?.name?.trim() || line.speaker?.source?.trim();
      if (!speaker) return text;
      return `${speaker}: ${text}`;
    })
    .filter((line): line is string => Boolean(line));

  const folders = (note.folder_membership ?? [])
    .map((f) => f.name?.trim())
    .filter((name): name is string => Boolean(name));

  const bodyParts: string[] = [];
  if (summary) bodyParts.push(`Summary\n${summary}`);
  if (transcriptLines.length > 0) bodyParts.push(`Transcript\n${transcriptLines.join("\n")}`);

  const createdAt = note.calendar_event?.scheduled_start_time ?? note.created_at;
  const title =
    note.title?.trim() ||
    note.calendar_event?.event_title?.trim() ||
    `Granola note ${note.id}`;

  return {
    source: "granola",
    id: note.id,
    url: `https://app.granola.ai/notes/${note.id}`,
    title,
    body: bodyParts.join("\n\n---\n\n") || "No content",
    ...(createdAt ? { capturedAt: createdAt } : {}),
    ...(people.length > 0 ? { people } : {}),
    ...(folders.length > 0 ? { folders } : {}),
  };
}

function loadState(statePath: string): GranolaPollerState {
  if (!existsSync(statePath)) {
    return {
      lastSeenUpdatedAt: getDefaultBootstrapTimestamp(),
      noteUpdatedAtById: {},
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GranolaPollerState>;
    const lastSeenUpdatedAt = typeof parsed.lastSeenUpdatedAt === "string" ? parsed.lastSeenUpdatedAt : getDefaultBootstrapTimestamp();
    const noteUpdatedAtById =
      parsed.noteUpdatedAtById && typeof parsed.noteUpdatedAtById === "object" ? parsed.noteUpdatedAtById : {};

    return { lastSeenUpdatedAt, noteUpdatedAtById };
  } catch {
    return {
      lastSeenUpdatedAt: getDefaultBootstrapTimestamp(),
      noteUpdatedAtById: {},
    };
  }
}

function saveState(statePath: string, state: GranolaPollerState): void {
  const directory = join(statePath, "..");
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

function getDefaultBootstrapTimestamp(): string {
  const lookbackHoursRaw = Number(process.env.GRANOLA_API_INITIAL_LOOKBACK_HOURS ?? GRANOLA_DEFAULT_BOOTSTRAP_LOOKBACK_HOURS);
  const lookbackHours = Number.isFinite(lookbackHoursRaw) && lookbackHoursRaw > 0
    ? lookbackHoursRaw
    : GRANOLA_DEFAULT_BOOTSTRAP_LOOKBACK_HOURS;
  return new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
}

function trimNoteVersionMap(input: Record<string, string>): Record<string, string> {
  const entries = Object.entries(input)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, GRANOLA_MAX_TRACKED_NOTES);
  return Object.fromEntries(entries);
}

function persistInboxPayload(workspaceRoot: string, payload: SourceInput): string {
  const inboxDir = join(workspaceRoot, "integrations/ai-note-router/inbox");
  if (!existsSync(inboxDir)) {
    mkdirSync(inboxDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const sourceId = sanitizeSourceId(payload.id);
  const filePath = join(inboxDir, `${stamp}-${payload.source}-${sourceId}.json`);
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}
