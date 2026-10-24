import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { join } from "path";
import { extractTasksFromFirefliesTranscript } from "./task-extraction.js";
import { isKnownIngest, loadKnownFingerprints } from "../state/ingest-dedupe.js";

type FirefliesWebhookPayload = {
  meetingId?: string;
  eventType?: string;
  clientReferenceId?: string;
  // Fireflies may include additional keys; we only depend on meetingId.
  [key: string]: unknown;
};

type TranscriptResponse = {
  data?: {
    transcript?: {
      id: string;
      title?: string | null;
      meeting_link?: string | null;
      transcript_url?: string | null;
      date?: string | null;
      summary?: {
        short_summary?: string | null;
        overview?: string | null;
        gist?: string | null;
        short_overview?: string | null;
        action_items?: string | null;
      } | null;
      meeting_attendees?: Array<{
        name?: string | null;
        displayName?: string | null;
        email?: string | null;
      }> | null;
      speakers?: Array<{
        id?: number | null;
        name?: string | null;
      }> | null;
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
  };
  errors?: Array<{ message?: string }>;
};

type Transcript = NonNullable<NonNullable<TranscriptResponse["data"]>["transcript"]>;
type TranscriptMeta = { id: string; title?: string | null; date?: number | null };
type TranscriptListResponse = {
  data?: {
    transcripts?: TranscriptMeta[] | null;
  };
  errors?: Array<{ message?: string }>;
};

function getEnv(name: string, opts?: { required?: boolean }): string | undefined {
  const v = process.env[name];
  if (opts?.required && (!v || v.trim() === "")) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function verifyFirefliesSignature(rawBody: string, req: IncomingMessage, secret: string): void {
  // Fireflies docs mention `x-hub-signature` containing an SHA-256 HMAC.
  const header = getHeader(req, "x-hub-signature");
  if (!header) {
    throw new Error("Missing x-hub-signature header");
  }

  // Be tolerant of formats like `sha256=<hex>`.
  const normalized = header.replace(/^sha256=/i, "").trim();
  const providedBuf = Buffer.from(normalized, "hex");
  const expectedHex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");

  if (providedBuf.length !== expectedBuf.length) {
    throw new Error("Invalid signature length");
  }

  const ok = timingSafeEqual(providedBuf, expectedBuf);
  if (!ok) {
    throw new Error("Invalid webhook signature");
  }
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  const trimmed = raw.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

async function fetchTranscript(meetingId: string): Promise<Transcript> {
  const apiKey = getEnv("FIREFLIES_API_KEY", { required: true });
  const endpoint = getEnv("FIREFLIES_GRAPHQL_URL") ?? "https://api.fireflies.ai/graphql";

  const query = `
    query Transcript($transcriptId: String!) {
      transcript(id: $transcriptId) {
        id
        title
        meeting_link
        transcript_url
        date
        summary {
          short_summary
          overview
          gist
          short_overview
          action_items
        }
        meeting_attendees {
          name
          displayName
          email
        }
        speakers {
          id
          name
        }
        sentences {
          speaker_name
          text
          raw_text
          start_time
          ai_filters {
            task
          }
        }
      }
    }
  `;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      variables: { transcriptId: meetingId },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Fireflies transcript fetch failed: ${resp.status} ${text}`);
  }

  const json = (await resp.json()) as TranscriptResponse;
  const transcript = json.data?.transcript;
  if (!transcript) {
    const message = json.errors?.[0]?.message ?? "No transcript data";
    throw new Error(`Fireflies transcript fetch missing data: ${message}`);
  }

  return transcript;
}

async function listTranscripts(options: {
  fromDate?: string;
  toDate?: string;
  limit: number;
  skip: number;
}): Promise<TranscriptMeta[]> {
  const apiKey = getEnv("FIREFLIES_API_KEY", { required: true });
  const endpoint = getEnv("FIREFLIES_GRAPHQL_URL") ?? "https://api.fireflies.ai/graphql";

  const query = `
    query Transcripts($fromDate: DateTime, $toDate: DateTime, $limit: Int, $skip: Int) {
      transcripts(fromDate: $fromDate, toDate: $toDate, limit: $limit, skip: $skip) {
        id
        title
        date
      }
    }
  `;

  const variables: Record<string, unknown> = {
    limit: options.limit,
    skip: options.skip,
  };
  if (options.fromDate) variables.fromDate = options.fromDate;
  if (options.toDate) variables.toDate = options.toDate;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Fireflies transcript list failed: ${resp.status} ${text}`);
  }

  const json = (await resp.json()) as TranscriptListResponse;
  if (json.errors?.length) {
    throw new Error(`Fireflies transcript list error: ${json.errors[0]?.message ?? "unknown error"}`);
  }

  return json.data?.transcripts?.filter((t): t is TranscriptMeta => Boolean(t?.id)) ?? [];
}

function pickSummaryText(transcript: Transcript): string {
  const summary = transcript.summary ?? null;
  const candidates = [
    summary?.short_summary ?? null,
    summary?.overview ?? null,
    summary?.short_overview ?? null,
    summary?.gist ?? null,
  ];

  const found = candidates.find((c) => typeof c === "string" && c.trim() !== "");
  if (found) return found.trim();

  // Router requires a non-empty string for `body`, so provide a safe fallback.
  return `Transcript summary not available (transcriptId: ${transcript.id}).`;
}

function pickBodyText(transcript: Transcript): string {
  const sentences = transcript.sentences ?? [];
  const fullTranscript = sentences
    .map((s) => {
      const text = (s.text ?? s.raw_text ?? "").trim();
      if (!text) return null;
      const speaker = (s.speaker_name ?? "").trim();
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter((line): line is string => line !== null)
    .join("\n");

  if (fullTranscript.trim()) {
    return fullTranscript;
  }

  // Fallback to summary if sentence-level transcript text is unavailable.
  return pickSummaryText(transcript);
}

function buildRouterPayload(transcript: Transcript): Record<string, unknown> {
  const url =
    transcript.meeting_link ??
    transcript.transcript_url ??
    `https://app.fireflies.ai/view/${encodeURIComponent(transcript.id)}`;

  // Fireflies sometimes returns meeting_attendees with email but without a usable name.
  // In that case, derive a fallback name from the email local-part so vault participant
  // inference (last-name matching) can still work.
  const meetingAttendees = transcript.meeting_attendees ?? [];
  const peopleFromAttendees = meetingAttendees
    .map((a) => {
      const email = a.email?.trim() ?? undefined;
      const rawName = (a.name ?? a.displayName ?? "").trim();
      let fallbackName = "";
      if (!rawName && email) {
        const localPart = (email?.split("@")[0] ?? "").trim();
        // sam.taylor -> "sam taylor"
        fallbackName = localPart.replace(/[._-]+/g, " ");
      }

      const name = (rawName || fallbackName).trim();
      if (!name && !email) return null;

      const out: { name: string; email?: string } = { name };
      if (email) out.email = email;
      return out;
    })
    .filter((x): x is { name: string; email?: string } => x !== null);

  // If we didn't get any usable attendees, fall back to speaker names.
  const speakers = (transcript as { speakers?: Array<{ id: number; name?: string | null }> }).speakers ?? [];
  const people =
    peopleFromAttendees.length > 0
      ? peopleFromAttendees
      : speakers
          .map((s) => (s.name ?? "").trim())
          .filter(Boolean)
          .filter((v, i, arr) => arr.indexOf(v) === i) // de-dupe
          .map((name) => ({ name }));

  const tasks = extractTasksFromFirefliesTranscript(transcript);

  return {
    id: transcript.id,
    url,
    title: (transcript.title ?? "Untitled meeting").toString(),
    body: pickBodyText(transcript),
    capturedAt: transcript.date ?? undefined,
    // The router normalization supports `people: [{ name, email? }]`.
    people,
    ...(tasks.length > 0 ? { tasks } : {}),
  };
}

async function forwardToRouter(payload: Record<string, unknown>): Promise<void> {
  const routerIngestUrl =
    getEnv("ROUTER_INGEST_URL") ?? `http://localhost:${getEnv("ROUTER_PORT") ?? "3333"}/ingest/fireflies`;

  const routerToken = getEnv("FIREFLIES_WEBHOOK_SECRET");
  if (!routerToken) {
    throw new Error(
      "FIREFLIES_WEBHOOK_SECRET is not set. The router is configured to require x-router-token.",
    );
  }

  const resp = await fetch(routerIngestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-router-token": routerToken,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Router ingest failed: ${resp.status} ${text}`);
  }
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  const raw = process.argv[idx + 1];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseNumberArg(name: string, fallback: number): number {
  const raw = parseArg(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function toIsoOrUndefined(raw?: string): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function toIsoFromHoursAgo(hours: number): string {
  const ms = Date.now() - hours * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

async function runBackfill(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const fromDate = toIsoOrUndefined(parseArg("--from")) ?? toIsoFromHoursAgo(parseNumberArg("--lookback-hours", 72));
  const toDate = toIsoOrUndefined(parseArg("--to"));
  const pageLimit = Math.min(parseNumberArg("--limit", 50), 50);
  const maxMeetings = parseNumberArg("--max-meetings", 200);

  const metas: TranscriptMeta[] = [];
  let skip = 0;
  while (metas.length < maxMeetings) {
    const pageOptions: { fromDate?: string; toDate?: string; limit: number; skip: number } = {
      fromDate,
      limit: Math.min(pageLimit, maxMeetings - metas.length),
      skip,
    };
    if (toDate) pageOptions.toDate = toDate;
    const page = await listTranscripts(pageOptions);
    metas.push(...page);
    if (page.length < pageLimit) break;
    skip += page.length;
  }

  const uniqueIds = Array.from(new Set(metas.map((m) => m.id)));
  const selected = uniqueIds.slice(0, maxMeetings);
  const results: Array<{ id: string; status: "ok" | "skipped" | "error"; error?: string }> = [];

  // The router already knows these meetings (processed, permanently skipped, or
  // still queued in the inbox). Replaying them re-queued every meeting ~96 times
  // over a 72h window and starved the Linear hourly budget; skip unless --force.
  const force = process.argv.includes("--force");
  const known = force
    ? new Set<string>()
    : loadKnownFingerprints({
        statePath: join(process.cwd(), "outputs/ai-note-router/processed-state.json"),
        inboxDir: join(process.cwd(), "integrations/ai-note-router/inbox"),
      });

  for (const id of selected) {
    if (isKnownIngest(known, "fireflies", id)) {
      results.push({ id, status: "skipped" });
      continue;
    }
    try {
      const transcript = await fetchTranscript(id);
      const payload = buildRouterPayload(transcript);
      if (!dryRun) {
        await forwardToRouter(payload);
      }
      results.push({ id, status: "ok" });
    } catch (error) {
      results.push({
        id,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const errorCount = results.length - okCount - skippedCount;
  sendBackfillSummary({
    dryRun,
    fromDate,
    toDate: toDate ?? null,
    attempted: results.length,
    succeeded: okCount,
    skippedAlreadyKnown: skippedCount,
    failed: errorCount,
    failures: results.filter((r) => r.status === "error"),
  });
}

function sendBackfillSummary(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseBackfillCliArgsFromEnv(): string[] {
  const args: string[] = [];
  const lookbackHours = parseEnvNumber("FIREFLIES_BACKFILL_LOOKBACK_HOURS", 72);
  const maxMeetings = parseEnvNumber("FIREFLIES_BACKFILL_MAX_MEETINGS", 50);
  const pageLimit = Math.min(parseEnvNumber("FIREFLIES_BACKFILL_PAGE_LIMIT", 50), 50);
  args.push("--lookback-hours", String(lookbackHours));
  args.push("--max-meetings", String(maxMeetings));
  args.push("--limit", String(pageLimit));
  return args;
}

function startPeriodicBackfillIfEnabled(): void {
  const intervalMinutes = parseEnvNumber("FIREFLIES_BACKFILL_INTERVAL_MINUTES", 0);
  if (intervalMinutes <= 0) return;

  const intervalMs = intervalMinutes * 60 * 1000;
  let running = false;
  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const originalArgv = [...process.argv];
      process.argv = [process.argv[0] ?? "node", process.argv[1] ?? "adapter", ...parseBackfillCliArgsFromEnv()];
      await runBackfill();
      process.argv = originalArgv;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ stage: "fireflies-backfill", ok: false, error: message })}\n`);
    } finally {
      running = false;
    }
  };

  // Kick once on startup, then keep reconciling in the background.
  void runOnce();
  setInterval(() => {
    void runOnce();
  }, intervalMs);
}

export async function main(): Promise<void> {
  if (process.argv.includes("--backfill")) {
    await runBackfill();
    return;
  }

  const port = Number(getEnv("ADAPTER_PORT") ?? "3000");
  const signingSecret = getEnv("FIREFLIES_WEBHOOK_SIGNING_SECRET");

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }

      // Support POSTs at root; Fireflies typically posts to exactly the URL you configure.
      // Cloudflare Tunnel will forward to this local service.
      const rawBody = await readRawBody(req);
      const requestBody = rawBody.trim() ? (JSON.parse(rawBody) as FirefliesWebhookPayload) : {};

      if (!signingSecret && getEnv("ROUTER_ALLOW_UNAUTHENTICATED") !== "1") {
        sendJson(res, 403, { ok: false, error: "FIREFLIES_WEBHOOK_SIGNING_SECRET is not configured" });
        return;
      }
      if (signingSecret) {
        verifyFirefliesSignature(rawBody, req, signingSecret);
      }

      const meetingId = requestBody.meetingId;
      if (!meetingId || typeof meetingId !== "string" || meetingId.trim() === "") {
        sendJson(res, 400, { ok: false, error: "Missing meetingId" });
        return;
      }

      const transcript = await fetchTranscript(meetingId);
      const routerPayload = buildRouterPayload(transcript);
      await forwardToRouter(routerPayload);

      sendJson(res, 200, { ok: true, meetingId, routedTo: routerPayload.url });
    } catch (error) {
      console.error("Fireflies adapter error:", error);
      sendJson(res, 500, { ok: false, error: "Internal error" });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, getEnv("ADAPTER_HOST") ?? "127.0.0.1", () => resolve());
  });

  console.log(`Fireflies adapter listening on http://localhost:${port}`);
  startPeriodicBackfillIfEnabled();
}

// Run when executed directly by `node .../dist/adapter/index.js`
void main();

