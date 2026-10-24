import { existsSync, mkdirSync, writeFileSync } from "fs";
import { logAudit } from "../audit/log.js";
import { isKnownIngest, loadKnownFingerprints } from "../state/ingest-dedupe.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { join } from "path";
import { checkWebhookToken, isDirectLoopback, isSameOriginOrNonBrowser, sanitizeSourceId } from "./security.js";
import type { RouterConfig } from "../config/types.js";
import type { SourceInput } from "../sources/types.js";
import type { CanonicalPerson, CanonicalTaskCandidate } from "../normalize/note.js";
import { startInboxWatcher } from "../worker/watch.js";

export type WebhookServerOptions = {
  workspaceRoot: string;
  config: RouterConfig;
  port: number;
  dryRun: boolean;
  apiKey?: string;
  host?: string;
};

export async function startWebhookServer(options: WebhookServerOptions): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, options);
    } catch (error) {
      respondJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });

  void startInboxWatcher({
    workspaceRoot: options.workspaceRoot,
    inboxDir: join(options.workspaceRoot, "integrations/ai-note-router/inbox"),
    statePath: join(options.workspaceRoot, "outputs/ai-note-router/processed-state.json"),
    config: options.config,
    dryRun: options.dryRun,
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });

  console.log(`AI note router webhook server listening on http://localhost:${options.port}`);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, options: WebhookServerOptions): Promise<void> {
  const parsedUrl = new URL(req.url || "/", `http://localhost:${options.port}`);
  const pathname = parsedUrl.pathname;
  const method = req.method || "GET";

  if (method === "GET" && pathname === "/health") {
    respondJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/ingest/granola") {
    respondHtml(res, 200, renderGranolaIngestPage());
    return;
  }

  if (method === "GET" && pathname === "/ingest/granola/calendar-events") {
    if (!isDirectLoopback(req.socket.remoteAddress, req.headers) || !isSameOriginOrNonBrowser(req.headers)) {
      respondJson(res, 403, { ok: false, error: "Forbidden" });
      return;
    }
    try {
      const dateParam = parsedUrl.searchParams.get("date");
      const includePrevDay = parsedUrl.searchParams.get("includePrevDay") === "1";
      const result = await loadCalendarEventsForLocalDay(dateParam, includePrevDay);
      respondJson(res, 200, {
        ok: true,
        date: result.dateLabel,
        events: result.events,
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      respondJson(res, 200, {
        ok: false,
        events: [],
        error: message,
        hint:
          "Check GRANOLA_CALENDAR_ICS_URL in .env, restart npm run serve, and verify curl -sSf <url> returns BEGIN:VCALENDAR.",
      });
    }
    return;
  }

  if (method !== "POST") {
    respondJson(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!pathname.startsWith("/ingest/")) {
    respondJson(res, 404, { ok: false, error: "Not found" });
    return;
  }

  const ingestType = pathname.split("/").pop();
  if (ingestType !== "fireflies" && ingestType !== "granola" && ingestType !== "manual") {
    respondJson(res, 400, { ok: false, error: "Unsupported ingest type" });
    return;
  }

  const ingestName = ingestType as "fireflies" | "granola" | "manual";
  const contentType = (req.headers["content-type"] ?? "").toString().toLowerCase();
  const isLocalGranolaForm =
    ingestName === "granola" &&
    contentType.includes("application/x-www-form-urlencoded") &&
    isDirectLoopback(req.socket.remoteAddress, req.headers) &&
    isSameOriginOrNonBrowser(req.headers);

  try {
    if (!isLocalGranolaForm) {
      verifyWebhookToken(req, ingestName);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    respondJson(res, err instanceof WebhookAuthError ? err.status : 401, { ok: false, error: message });
    return;
  }

  let rawPayload: SourceInput;
  if (ingestName === "manual") {
    rawPayload = await parseManualInput(req);
  } else if (isLocalGranolaForm) {
    rawPayload = await parseGranolaFormInput(req);
  } else {
    const body = await readJsonBody(req);
    rawPayload = parseSourceInput(body, ingestName);
  }

  // Re-queueing a payload the router already processed, permanently skipped, or
  // still has waiting only burns Linear requests (the Fireflies backfill replays
  // the same meetings every run), so answer 200 without writing a new file.
  const known = loadKnownFingerprints({
    statePath: join(options.workspaceRoot, "outputs/ai-note-router/processed-state.json"),
    inboxDir: join(options.workspaceRoot, "integrations/ai-note-router/inbox"),
  });
  if (rawPayload.id && isKnownIngest(known, rawPayload.source, rawPayload.id)) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "ingest",
      message: "Ingest payload already known (processed, skipped, or queued); not re-queued",
      payload: { source: rawPayload.source, id: rawPayload.id, title: rawPayload.title },
    });
    respondJson(res, 200, {
      ok: true,
      inboxFile: null,
      queued: false,
      reason: "already-known",
      source: rawPayload.source,
      id: rawPayload.id,
      title: rawPayload.title,
    });
    return;
  }

  const inboxFile = options.dryRun ? null : persistInboxPayload(options.workspaceRoot, rawPayload);

  respondJson(res, 200, {
    ok: true,
    inboxFile,
    queued: true,
    source: rawPayload.source,
    id: rawPayload.id,
    title: rawPayload.title,
  });
}

function verifyWebhookToken(req: IncomingMessage, source: "fireflies" | "granola" | "manual"): void {
  const secret =
    source === "fireflies"
      ? process.env.FIREFLIES_WEBHOOK_SECRET
      : source === "granola"
        ? process.env.GRANOLA_WEBHOOK_SECRET
        : process.env.MANUAL_WEBHOOK_SECRET;
  const result = checkWebhookToken(source, secret, req.headers["x-router-token"], process.env.ROUTER_ALLOW_UNAUTHENTICATED === "1");
  if (!result.ok) {
    throw new WebhookAuthError(result.status, result.error);
  }
}

class WebhookAuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  return JSON.parse(raw) as Record<string, unknown>;
}

async function readTextBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function parseSourceInput(body: Record<string, unknown>, source: "fireflies" | "granola"): SourceInput {
  const id = requireString(body, "id");
  const url = requireString(body, "url");
  const title = requireString(body, "title");
  const meetingBody = requireString(body, "body");

  const input: SourceInput = {
    source,
    id,
    url,
    title,
    body: meetingBody,
  };

  if (typeof body.capturedAt === "string") {
    input.capturedAt = body.capturedAt;
  }
  if (typeof body.client === "string") {
    input.client = body.client;
  }
  if (typeof body.project === "string") {
    input.project = body.project;
  }
  if (typeof body.team === "string") {
    input.team = body.team;
  }
  // Provider payloads often use different terminology (people/participants/attendees) and
  // may send strings or objects like { displayName, email }.
  const peopleLike =
    (Array.isArray(body.people) ? body.people : null) ??
    (Array.isArray(body.participants) ? body.participants : null) ??
    (Array.isArray(body.attendees) ? body.attendees : null);
  if (peopleLike) {
    const normalizedPeople = normalizePeopleArray(peopleLike);
    if (normalizedPeople.length > 0) {
      input.people = normalizedPeople;
    }
  }
  if (Array.isArray(body.tasks)) {
    input.tasks = body.tasks as CanonicalTaskCandidate[];
  }
  if (Array.isArray(body.tags)) {
    input.tags = body.tags as string[];
  }

  return input;
}

async function parseManualInput(req: IncomingMessage): Promise<SourceInput> {
  const contentType = (req.headers["content-type"] ?? "").toString().toLowerCase();
  const raw = await readTextBody(req);
  if (!raw) {
    throw new Error("Manual ingest requires a non-empty transcript body");
  }

  // For JSON requests, allow { transcript/body } for the content plus optional metadata fields.
  let json: Record<string, unknown> | null = null;
  if (contentType.includes("application/json")) {
    json = JSON.parse(raw) as Record<string, unknown>;
  }

  const transcriptCandidate =
    (json && typeof json.body === "string" ? json.body : null) ??
    (json && typeof json.transcript === "string" ? json.transcript : null) ??
    (json && typeof json.text === "string" ? json.text : null) ??
    null;

  const transcript = json ? transcriptCandidate : raw;
  if (json && !transcript) {
    throw new Error("Manual ingest JSON requires one of: 'body', 'transcript', or 'text'");
  }

  const body = (transcript ?? "").trim();
  if (!body) {
    throw new Error("Manual ingest transcript was empty after trimming");
  }

  const id =
    (json && typeof json.id === "string" ? json.id.trim() : null) ??
    new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = id.replace(/\s+/g, "-");

  const url =
    (json && typeof json.url === "string" ? json.url.trim() : null) ??
    `manual://${safeId}`;

  const title =
    (json && typeof json.title === "string" ? json.title.trim() : null) ??
    deriveTitleFromTranscript(body);

  const input: SourceInput = {
    source: "fireflies",
    id: safeId,
    url,
    title,
    body,
  };

  if (typeof json?.capturedAt === "string" && json.capturedAt.trim()) {
    input.capturedAt = json.capturedAt.trim();
  }
  if (typeof json?.client === "string" && json.client.trim()) {
    input.client = json.client.trim();
  }
  if (typeof json?.project === "string" && json.project.trim()) {
    input.project = json.project.trim();
  }
  if (typeof json?.team === "string" && json.team.trim()) {
    input.team = json.team.trim();
  }

  const peopleLike =
    (json && (Array.isArray(json.people) ? json.people : null)) ??
    (json && (Array.isArray(json.participants) ? json.participants : null)) ??
    (json && (Array.isArray(json.attendees) ? json.attendees : null));

  if (peopleLike) {
    const normalizedPeople = normalizePeopleArray(peopleLike);
    if (normalizedPeople.length > 0) {
      input.people = normalizedPeople;
    }
  }

  if (json && Array.isArray(json.tasks)) {
    input.tasks = json.tasks as CanonicalTaskCandidate[];
  }

  if (json && Array.isArray(json.tags)) {
    input.tags = json.tags as string[];
  }

  return input;
}

async function parseGranolaFormInput(req: IncomingMessage): Promise<SourceInput> {
  const raw = await readTextBody(req);
  const params = new URLSearchParams(raw);

  const title = (params.get("title") ?? "").trim();
  const summary = (params.get("summary") ?? "").trim();
  const transcript = (params.get("transcript") ?? "").trim();
  const attendeesRaw = (params.get("attendees") ?? "").trim();
  const capturedAt = (params.get("capturedAt") ?? "").trim();
  const speakerAName = (params.get("speakerAName") ?? "").trim();
  const speakerBName = (params.get("speakerBName") ?? "").trim();
  const myName = (params.get("myName") ?? "").trim();
  const mySpeakerRole = (params.get("mySpeakerRole") ?? "").trim().toUpperCase();

  if (!title) {
    throw new Error("Granola form ingest requires a meeting title");
  }
  if (!summary && !transcript) {
    throw new Error("Granola form ingest requires summary or transcript");
  }

  const id = `manual-granola-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const normalizedTranscript = applySpeakerMapping(transcript, {
    speakerAName,
    speakerBName,
    myName,
    mySpeakerRole,
  });
  const bodyParts: string[] = [];
  if (summary) bodyParts.push(`Summary\n${summary}`);
  if (normalizedTranscript) bodyParts.push(`Transcript\n${normalizedTranscript}`);

  const payload: SourceInput = {
    source: "granola",
    id,
    url: `manual://granola/${id}`,
    title,
    body: bodyParts.join("\n\n---\n\n"),
  };

  if (capturedAt) {
    payload.capturedAt = capturedAt;
  }

  const people = attendeesRaw
    .split(/\n|,|;/g)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  if (people.length > 0) {
    payload.people = people;
  }

  return payload;
}

type SpeakerMappingInput = {
  speakerAName: string;
  speakerBName: string;
  myName: string;
  mySpeakerRole: string;
};

function applySpeakerMapping(transcript: string, input: SpeakerMappingInput): string {
  if (!transcript.trim()) return transcript;

  const explicitA = input.speakerAName.trim();
  const explicitB = input.speakerBName.trim();
  const me = input.myName.trim();
  const role = input.mySpeakerRole;

  let mappedA = explicitA;
  let mappedB = explicitB;
  if (me && (role === "A" || role === "B")) {
    if (role === "A" && !mappedA) mappedA = me;
    if (role === "B" && !mappedB) mappedB = me;
  }

  let out = transcript;
  if (mappedA) {
    out = out.replace(/(^|\n)\s*Speaker A:\s*/gi, `$1${mappedA}: `);
  }
  if (mappedB) {
    out = out.replace(/(^|\n)\s*Speaker B:\s*/gi, `$1${mappedB}: `);
  }
  return out;
}

type CalendarEventLite = {
  id: string;
  title: string;
  startsAt?: string;
  attendees: string[];
};

function resolveLocalCalendarDay(dateParam: string | null): { day: Date; dateLabel: string } {
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    const parts = dateParam.split("-");
    const y = Number(parts[0] ?? NaN);
    const mo = Number(parts[1] ?? NaN);
    const d = Number(parts[2] ?? NaN);
    if (Number.isFinite(y) && Number.isFinite(mo) && Number.isFinite(d)) {
      return { day: new Date(y, mo - 1, d), dateLabel: dateParam };
    }
  }
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateLabel = formatLocalIsoDate(day);
  return { day, dateLabel };
}

function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function loadCalendarEventsForLocalDay(
  dateParam: string | null,
  includePrevDay = false,
): Promise<{ events: CalendarEventLite[]; warning?: string; dateLabel: string }> {
  const rawUrl = process.env.GRANOLA_CALENDAR_ICS_URL?.trim().replace(/^["']|["']$/g, "");
  if (!rawUrl) {
    const { dateLabel } = resolveLocalCalendarDay(dateParam);
    return { events: [], dateLabel };
  }

  const response = await fetch(rawUrl, {
    headers: {
      // Google sometimes rejects bare Node fetch; behave like a normal client.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/calendar, text/plain, */*",
    },
  });
  if (!response.ok) {
    throw new Error(`Calendar ICS fetch failed: HTTP ${response.status} ${response.statusText}`);
  }
  const ics = await response.text();
  if (!ics.includes("BEGIN:VCALENDAR") && !ics.toUpperCase().includes("BEGIN:VCALENDAR")) {
    throw new Error(
      "Calendar response does not look like an ICS file (missing BEGIN:VCALENDAR). Check the URL is the Secret iCal address.",
    );
  }
  const { day, dateLabel } = resolveLocalCalendarDay(dateParam);
  return parseIcsEventsForLocalDay(ics, day, dateLabel, includePrevDay);
}

function parseIcsEventsForLocalDay(
  ics: string,
  dayAnchor: Date,
  dateLabel: string,
  includePrevDay: boolean,
): { events: CalendarEventLite[]; warning?: string; dateLabel: string } {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const blocks: string[] = [];
  const veventRe = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let vm: RegExpExecArray | null;
  while ((vm = veventRe.exec(unfolded)) !== null) {
    blocks.push(vm[1] ?? "");
  }

  const y = dayAnchor.getFullYear();
  const mo = dayAnchor.getMonth();
  const d = dayAnchor.getDate();
  const dayStart = new Date(y, mo, d, 0, 0, 0, 0).getTime() - (includePrevDay ? 24 * 60 * 60 * 1000 : 0);
  const dayEnd = new Date(y, mo, d, 23, 59, 59, 999).getTime();

  const out: CalendarEventLite[] = [];
  let skippedOutsideToday = 0;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const title = pickIcsProp(block, "SUMMARY") ?? "Untitled meeting";
    const uid = pickIcsProp(block, "UID") ?? `${title}-${Math.random().toString(36).slice(2, 8)}`;
    const dtStartRaw = pickIcsProp(block, "DTSTART");
    const dtEndRaw = pickIcsProp(block, "DTEND");
    const startsAt = parseIcsDate(dtStartRaw);
    const endsAt = parseIcsDate(dtEndRaw);

    if (startsAt) {
      const startMs = startsAt.getTime();
      let endMs = endsAt?.getTime() ?? startMs;
      // Timed events usually include DTEND; if missing, assume ~1h (not for all-day VALUE=DATE-only).
      if (!endsAt && dtEndRaw == null) {
        const dateOnly = typeof dtStartRaw === "string" && /^\d{8}$/.test(dtStartRaw.trim());
        if (!dateOnly) {
          endMs = startMs + 60 * 60 * 1000;
        }
      }
      // Include if the event interval overlaps the selected local day (or day+previous day).
      const overlapsDay = startMs <= dayEnd && endMs >= dayStart;
      if (!overlapsDay) {
        skippedOutsideToday += 1;
        continue;
      }
    } else {
      // No parseable start: still show (better than hiding everything on format quirks).
    }

    const attendees = Array.from(block.matchAll(/^ATTENDEE(?:;[^:]*)?:(.+)$/gim))
      .map((m) => (m[1] ?? "").trim())
      .map((value) => value.replace(/^mailto:/i, "").trim())
      .filter(Boolean);

    const event: CalendarEventLite = {
      id: uid,
      title,
      attendees,
    };
    if (startsAt) {
      event.startsAt = startsAt.toISOString();
    }
    out.push(event);
  }

  const sorted = out.sort((a, b) => {
    const aTs = a.startsAt ? Date.parse(a.startsAt) : Number.MAX_SAFE_INTEGER;
    const bTs = b.startsAt ? Date.parse(b.startsAt) : Number.MAX_SAFE_INTEGER;
    return aTs - bTs;
  });

  let warning: string | undefined;
  if (sorted.length === 0 && blocks.filter((b) => b.trim()).length > 0) {
    warning = `Loaded calendar but no events overlap ${includePrevDay ? `${dateLabel} or previous day` : dateLabel} (local). Parsed blocks: ${blocks.filter((b) => b.trim()).length}, skipped (other days): ${skippedOutsideToday}.`;
  }

  return { events: sorted, dateLabel, ...(warning ? { warning } : {}) };
}

function pickIcsProp(block: string, key: string): string | null {
  const regex = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "im");
  const m = block.match(regex);
  return m?.[1]?.trim() ?? null;
}

function parseIcsDate(raw: string | null): Date | null {
  if (!raw) return null;

  // Supports:
  // - 20260323T143000Z
  // - 20260323T143000
  // - 20260323
  // - 20260323T143000.000Z (Google occasionally emits fractional seconds)
  const base = raw
    .trim()
    .replace(/\.\d{3}Z$/i, "Z")
    .replace(/\.\d{3}$/i, "");

  if (/^\d{8}T\d{6}Z$/i.test(base)) {
    const y = Number(base.slice(0, 4));
    const mo = Number(base.slice(4, 6)) - 1;
    const d = Number(base.slice(6, 8));
    const h = Number(base.slice(9, 11));
    const mi = Number(base.slice(11, 13));
    const s = Number(base.slice(13, 15));
    return new Date(Date.UTC(y, mo, d, h, mi, s));
  }
  if (/^\d{8}T\d{6}$/.test(base)) {
    const y = Number(base.slice(0, 4));
    const mo = Number(base.slice(4, 6)) - 1;
    const d = Number(base.slice(6, 8));
    const h = Number(base.slice(9, 11));
    const mi = Number(base.slice(11, 13));
    const s = Number(base.slice(13, 15));
    return new Date(y, mo, d, h, mi, s);
  }
  if (/^\d{8}$/.test(base)) {
    const y = Number(base.slice(0, 4));
    const mo = Number(base.slice(4, 6)) - 1;
    const d = Number(base.slice(6, 8));
    return new Date(y, mo, d, 0, 0, 0);
  }
  return null;
}

function deriveTitleFromTranscript(transcript: string): string {
  const firstLine = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => Boolean(l)) ?? "Manual transcript";

  const trimmed = firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  return trimmed;
}

function normalizePeopleArray(raw: unknown): CanonicalPerson[] {
  if (!Array.isArray(raw)) return [];

  const out: CanonicalPerson[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) out.push({ name });
      continue;
    }

    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const emailCandidate =
      typeof obj.email === "string" ? obj.email.trim() : null;

    const nameCandidate =
      (typeof obj.name === "string" ? obj.name : null) ??
      (typeof obj.displayName === "string" ? obj.displayName : null) ??
      (typeof obj.fullName === "string" ? obj.fullName : null) ??
      (emailCandidate ?? null);

    if (typeof nameCandidate !== "string") continue;
    const name = nameCandidate.trim();
    if (!name) continue;

    const person: CanonicalPerson = { name };
    if (emailCandidate) person.email = emailCandidate;
    if (typeof obj.role === "string") person.role = obj.role;
    if (typeof obj.company === "string") person.company = obj.company;
    if (typeof obj.organization === "string" && !person.company) person.company = obj.organization;

    out.push(person);
  }

  return out;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Webhook payload is missing required string field '${key}'`);
  }

  return value;
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

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function respondHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}

function renderGranolaIngestPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Granola Quick Ingest</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 24px; max-width: 920px; }
    h1 { margin: 0 0 6px; }
    .sub { margin: 0 0 16px; opacity: 0.75; }
    label { display: block; font-weight: 600; margin: 14px 0 6px; }
    input, textarea, button, select {
      width: 100%; box-sizing: border-box; font: inherit; padding: 10px; border-radius: 8px; border: 1px solid #8885;
    }
    textarea { min-height: 96px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .hint { font-size: 12px; opacity: 0.75; margin-top: 6px; }
    button { cursor: pointer; font-weight: 700; margin-top: 14px; }
    #status { margin-top: 12px; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .meeting-picker-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .meeting-picker-row #meetingDate { width: auto; min-width: 11rem; flex: 0 0 auto; }
    .meeting-picker-row #eventSelect { flex: 1 1 200px; min-width: 0; }
    .calendar-icon-btn {
      flex: 0 0 auto; width: 44px; height: 44px; padding: 0; display: inline-flex;
      align-items: center; justify-content: center; border-radius: 8px; border: 1px solid #8885;
      background: transparent; cursor: pointer; margin: 0;
    }
    .calendar-icon-btn:hover { opacity: 0.85; }
    .calendar-icon-btn svg { display: block; }
  </style>
</head>
<body>
  <h1>Granola Quick Ingest</h1>
  <p class="sub">Paste summary + transcript and queue to AI Note Router in one submit.</p>

  <form id="granola-form" method="post" action="/ingest/granola">
    <label for="eventSelect">Meetings from calendar (optional, from ICS)</label>
    <div class="meeting-picker-row">
      <button type="button" id="calendarDateBtn" class="calendar-icon-btn" title="Choose date" aria-label="Choose date for meeting list">
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
      </button>
      <input type="date" id="meetingDate" title="Date to load meetings for" />
      <select id="eventSelect">
        <option value="">-- Select a meeting to prefill title/attendees --</option>
      </select>
    </div>
    <div class="hint">Set <code>GRANOLA_CALENDAR_ICS_URL</code> in <code>.env</code> to enable auto-loading this list. Restart <code>npm run serve</code> after changing <code>.env</code>.</div>
    <label style="display:flex; align-items:center; gap:8px; margin:8px 0 0; font-weight:500;">
      <input type="checkbox" id="includePrevDay" style="width:auto;" />
      Include previous day (last 2 days)
    </label>
    <div id="calendarHint" class="hint" style="color:#c45;"></div>

    <label for="title">Meeting title</label>
    <input id="title" name="title" required placeholder="Client Weekly Check-in" />

    <div class="row">
      <div>
        <label for="capturedAt">Captured at (optional)</label>
        <input id="capturedAt" name="capturedAt" placeholder="2026-03-23T14:30:00-04:00" />
      </div>
      <div>
        <label for="attendees">Attendees (optional)</label>
        <input id="attendees" name="attendees" placeholder="Name 1, Name 2" />
      </div>
    </div>

    <div class="row">
      <div>
        <label for="myName">My name (optional)</label>
        <input id="myName" name="myName" placeholder="Alex Morgan" />
      </div>
      <div>
        <label for="mySpeakerRole">I am speaker</label>
        <select id="mySpeakerRole" name="mySpeakerRole">
          <option value="">-- Unknown --</option>
          <option value="A">Speaker A</option>
          <option value="B">Speaker B</option>
        </select>
      </div>
    </div>

    <div class="row">
      <div>
        <label for="speakerAName">Speaker A name override (optional)</label>
        <input id="speakerAName" name="speakerAName" placeholder="Pat Lee" />
      </div>
      <div>
        <label for="speakerBName">Speaker B name override (optional)</label>
        <input id="speakerBName" name="speakerBName" placeholder="Alex Morgan" />
      </div>
    </div>

    <label for="summary">Summary</label>
    <textarea id="summary" name="summary" placeholder="Granola summary..."></textarea>

    <label for="transcript">Transcript</label>
    <textarea id="transcript" name="transcript" style="min-height:280px" placeholder="Granola transcript..."></textarea>

    <button type="submit">Queue Granola Note</button>
  </form>

  <pre id="status"></pre>

  <script>
    const statusEl = document.getElementById("status");
    const calendarHintEl = document.getElementById("calendarHint");
    const meetingDateEl = document.getElementById("meetingDate");
    const calendarDateBtn = document.getElementById("calendarDateBtn");
    const includePrevDayEl = document.getElementById("includePrevDay");
    const eventSelect = document.getElementById("eventSelect");
    const titleEl = document.getElementById("title");
    const attendeesEl = document.getElementById("attendees");
    const capturedAtEl = document.getElementById("capturedAt");
    const speakerANameEl = document.getElementById("speakerAName");
    const speakerBNameEl = document.getElementById("speakerBName");

    let eventMap = new Map();

    function localIsoDate(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + day;
    }

    meetingDateEl.value = localIsoDate(new Date());

    calendarDateBtn.addEventListener("click", () => {
      if (typeof meetingDateEl.showPicker === "function") {
        meetingDateEl.showPicker();
      } else {
        meetingDateEl.focus();
      }
    });

    meetingDateEl.addEventListener("change", () => {
      eventMap = new Map();
      while (eventSelect.options.length > 1) {
        eventSelect.remove(1);
      }
      eventSelect.selectedIndex = 0;
      loadEvents();
    });
    includePrevDayEl.addEventListener("change", () => {
      eventMap = new Map();
      while (eventSelect.options.length > 1) {
        eventSelect.remove(1);
      }
      eventSelect.selectedIndex = 0;
      loadEvents();
    });

    async function loadEvents() {
      calendarHintEl.textContent = "";
      const dateQ = meetingDateEl.value || localIsoDate(new Date());
      try {
        const query = new URLSearchParams({
          date: dateQ,
          includePrevDay: includePrevDayEl.checked ? "1" : "0",
        });
        const resp = await fetch("/ingest/granola/calendar-events?" + query.toString());
        const json = await resp.json();
        if (json.error) {
          calendarHintEl.textContent = "Calendar load failed: " + json.error + (json.hint ? " — " + json.hint : "");
          return;
        }
        const dayLabel = json.date ? " (" + json.date + ")" : "";
        if (json.warning) {
          calendarHintEl.textContent = json.warning;
        }
        if (!Array.isArray(json.events) || json.events.length === 0) {
          if (!json.warning) {
            calendarHintEl.textContent = "No meetings for this date" + dayLabel + " (or calendar has no events). If you just edited .env, restart the router.";
          }
          return;
        }
        for (const ev of json.events) {
          eventMap.set(ev.id, ev);
          const opt = document.createElement("option");
          const when = ev.startsAt ? new Date(ev.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "No time";
          opt.value = ev.id;
          opt.textContent = when + " - " + ev.title;
          eventSelect.appendChild(opt);
        }
      } catch (err) {
        calendarHintEl.textContent = "Calendar load failed: " + String(err);
      }
    }

    eventSelect.addEventListener("change", () => {
      const ev = eventMap.get(eventSelect.value);
      if (!ev) return;
      titleEl.value = ev.title || "";
      attendeesEl.value = Array.isArray(ev.attendees) ? ev.attendees.join(", ") : "";
      capturedAtEl.value = ev.startsAt || "";
      // Smart defaults to reduce A/B inversion mistakes.
      const attendeeNames = (Array.isArray(ev.attendees) ? ev.attendees : [])
        .map((v) => String(v || "").replace(/^mailto:/i, "").trim())
        .filter(Boolean);
      if (!speakerANameEl.value && attendeeNames[0]) speakerANameEl.value = attendeeNames[0];
      if (!speakerBNameEl.value && attendeeNames[1]) speakerBNameEl.value = attendeeNames[1];
    });

    document.getElementById("granola-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      statusEl.textContent = "Submitting...";
      const form = e.currentTarget;
      const body = new URLSearchParams(new FormData(form));
      try {
        const resp = await fetch("/ingest/granola", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body
        });
        const json = await resp.json();
        statusEl.textContent = JSON.stringify(json, null, 2);
      } catch (err) {
        statusEl.textContent = String(err);
      }
    });

    loadEvents();
  </script>
</body>
</html>`;
}
