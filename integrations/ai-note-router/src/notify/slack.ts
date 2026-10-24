import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { RouterConfig } from "../config/types.js";
import type { CanonicalNote } from "../normalize/note.js";
import { logAudit } from "../audit/log.js";

type NotificationSystem = "obsidian" | "linear";
type NotificationEventType = "task_created" | "task_updated" | "task_completed" | "daily_report" | "manual_report";
type NotificationCadence = RouterConfig["notifications"]["cadence"];

type TaskNotificationEvent = {
  id: string;
  createdAt: string;
  source: "fireflies" | "granola";
  system: NotificationSystem;
  event: "task_created";
  title: string;
  contextTitle: string;
  link?: string;
};

type NotificationQueueState = {
  version: 1;
  events: TaskNotificationEvent[];
  lastSentAtByCadence: Partial<Record<NotificationCadence, string>>;
  lastDailyReportLocalDate?: string;
};

const QUEUE_RELATIVE_PATH = "outputs/ai-note-router/notification-queue.json";

export type NotifyTaskEventsInput = {
  workspaceRoot: string;
  config: RouterConfig;
  note: CanonicalNote;
  obsidianCreatedTaskTitles: string[];
  linearResult?: { action: "create" | "update" | "skip"; identifier?: string; title?: string };
};

export async function notifyTaskEvents(input: NotifyTaskEventsInput): Promise<void> {
  const { config, note } = input;
  if (!config.notifications.enabled) return;
  if (note.source.source !== "fireflies" && note.source.source !== "granola") return;
  if (!config.notifications.include_sources.includes(note.source.source)) return;
  if (!config.notifications.include_events.includes("task_created")) return;

  const webhookUrl = process.env[config.notifications.slack_webhook_env_var];
  if (!webhookUrl) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "notify",
      message: "Skipping Slack notification: webhook env var is not set.",
      payload: { envVar: config.notifications.slack_webhook_env_var },
    });
    return;
  }

  const now = new Date().toISOString();
  const events = buildEvents(input, now);
  if (events.length === 0) return;

  if (config.notifications.cadence === "realtime") {
    await postRealtime(webhookUrl, config, note, events);
    return;
  }

  const queuePath = join(input.workspaceRoot, QUEUE_RELATIVE_PATH);
  const state = readQueueState(queuePath);
  state.events.push(...events);
  await maybeFlushCadenceBucket(state, config.notifications.cadence, config.notifications.daily_report.hour_local, webhookUrl, config);
  writeQueueState(queuePath, state);
}

function buildEvents(input: NotifyTaskEventsInput, timestamp: string): TaskNotificationEvent[] {
  const events: TaskNotificationEvent[] = [];
  const contextTitle = input.note.title || "Meeting transcript";
  const source = input.note.source.source as "fireflies" | "granola";

  if (input.config.notifications.include_systems.includes("obsidian")) {
    for (const title of input.obsidianCreatedTaskTitles) {
      const cleaned = title.trim();
      if (!cleaned) continue;
      events.push({
        id: `${source}:obsidian:task_created:${slugify(cleaned)}:${input.note.source.externalId ?? input.note.title}`,
        createdAt: timestamp,
        source,
        system: "obsidian",
        event: "task_created",
        title: cleaned,
        contextTitle,
      });
    }
  }

  if (
    input.config.notifications.include_systems.includes("linear") &&
    input.linearResult?.action === "create" &&
    input.linearResult.title
  ) {
    const cleaned = input.linearResult.title.trim();
    if (cleaned) {
      events.push({
        id: `${source}:linear:task_created:${slugify(cleaned)}:${input.note.source.externalId ?? input.note.title}`,
        createdAt: timestamp,
        source,
        system: "linear",
        event: "task_created",
        title: cleaned,
        contextTitle,
        ...(input.linearResult.identifier
          ? { link: `https://linear.app/issue/${input.linearResult.identifier}` }
          : {}),
      });
    }
  }

  return dedupeEvents(events);
}

function readQueueState(path: string): NotificationQueueState {
  if (!existsSync(path)) {
    return { version: 1, events: [], lastSentAtByCadence: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as NotificationQueueState;
    if (!Array.isArray(parsed.events) || typeof parsed.lastSentAtByCadence !== "object") {
      return { version: 1, events: [], lastSentAtByCadence: {} };
    }
    return parsed;
  } catch {
    return { version: 1, events: [], lastSentAtByCadence: {} };
  }
}

function writeQueueState(path: string, state: NotificationQueueState): void {
  ensureDirectory(path);
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function postRealtime(
  webhookUrl: string,
  config: RouterConfig,
  note: CanonicalNote,
  events: TaskNotificationEvent[]
): Promise<void> {
  const title = `Transcript processed (${note.source.source})`;
  const sourceUrlLine = note.source.url ? `Source: ${note.source.url}` : null;
  const lines = [
    `*${title}*`,
    sourceUrlLine,
    ...events.map((event) => formatEventLine(event)),
  ].filter((line): line is string => Boolean(line));
  await postSlackMessage(webhookUrl, config.notifications.slack_channel, lines.join("\n"));
}

async function maybeFlushCadenceBucket(
  state: NotificationQueueState,
  cadence: NotificationCadence,
  dailyHourLocal: number,
  webhookUrl: string,
  config: RouterConfig
): Promise<void> {
  const now = new Date();
  const lastSentAt = state.lastSentAtByCadence[cadence];
  if (!shouldFlush(cadence, now, lastSentAt, state, dailyHourLocal)) return;

  const queuedEvents = state.events.splice(0, state.events.length);
  if (queuedEvents.length === 0) {
    state.lastSentAtByCadence[cadence] = now.toISOString();
    return;
  }

  const grouped = groupEvents(queuedEvents);
  const lines = [
    `*Task notifications (${humanCadence(cadence)})*`,
    `Window end: ${now.toLocaleString()}`,
    "",
    ...grouped,
  ];

  try {
    await postSlackMessage(webhookUrl, config.notifications.slack_channel, lines.join("\n"));
    state.lastSentAtByCadence[cadence] = now.toISOString();
    if (cadence === "daily") {
      state.lastDailyReportLocalDate = toLocalDateKey(now);
    }
  } catch (error) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "notify",
      message: "Failed to flush cadence notification bucket.",
      payload: { cadence, error: error instanceof Error ? error.message : String(error) },
    });
    state.events.unshift(...queuedEvents);
  }
}

function shouldFlush(
  cadence: NotificationCadence,
  now: Date,
  lastSentAt: string | undefined,
  state: NotificationQueueState,
  dailyHourLocal: number
): boolean {
  if (cadence === "daily") {
    const hourNow = now.getHours();
    if (hourNow < dailyHourLocal) return false;
    const todayKey = toLocalDateKey(now);
    return state.lastDailyReportLocalDate !== todayKey;
  }

  const last = lastSentAt ? new Date(lastSentAt) : null;
  if (!last || Number.isNaN(last.getTime())) return true;
  const elapsedMs = now.getTime() - last.getTime();
  return elapsedMs >= cadenceToMs(cadence);
}

function cadenceToMs(cadence: NotificationCadence): number {
  switch (cadence) {
    case "hourly":
      return 60 * 60 * 1000;
    case "every_3_hours":
      return 3 * 60 * 60 * 1000;
    case "every_8_hours":
      return 8 * 60 * 60 * 1000;
    case "daily":
      return 24 * 60 * 60 * 1000;
    case "realtime":
    default:
      return 0;
  }
}

function humanCadence(cadence: NotificationCadence): string {
  if (cadence === "every_3_hours") return "every 3 hours";
  if (cadence === "every_8_hours") return "every 8 hours";
  return cadence;
}

function groupEvents(events: TaskNotificationEvent[]): string[] {
  const lines: string[] = [];
  const bySystem = new Map<NotificationSystem, TaskNotificationEvent[]>();
  for (const event of events) {
    const list = bySystem.get(event.system) ?? [];
    list.push(event);
    bySystem.set(event.system, list);
  }

  for (const system of ["obsidian", "linear"] as const) {
    const list = bySystem.get(system) ?? [];
    if (list.length === 0) continue;
    lines.push(`*${capitalize(system)}* (${list.length})`);
    for (const event of list.slice(0, 25)) {
      lines.push(`- ${formatEventLine(event)}`);
    }
    if (list.length > 25) lines.push(`- ...and ${list.length - 25} more`);
    lines.push("");
  }
  return lines;
}

function formatEventLine(event: TaskNotificationEvent): string {
  const source = `[${event.source}]`;
  const context = event.contextTitle ? ` (${event.contextTitle})` : "";
  const suffix = event.link ? ` — ${event.link}` : "";
  return `${source} ${event.title}${context}${suffix}`;
}

async function postSlackMessage(webhookUrl: string, channel: string | null, text: string): Promise<void> {
  const body: Record<string, unknown> = { text };
  if (channel) body.channel = channel;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}`);
  }
}

function ensureDirectory(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function dedupeEvents(events: TaskNotificationEvent[]): TaskNotificationEvent[] {
  const seen = new Set<string>();
  const out: TaskNotificationEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out;
}

function toLocalDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
