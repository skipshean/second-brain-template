import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadRouterConfig } from "./config/load.js";
import type { RouterConfig } from "./config/types.js";
import { logAudit } from "./audit/log.js";
import type { CanonicalNote, SourceName } from "./normalize/note.js";
import type { SourceInput } from "./sources/types.js";
import { firefliesAdapter } from "./sources/fireflies.js";
import { granolaAdapter } from "./sources/granola.js";
import { processNote } from "./worker/process.js";
import { LinearClient } from "./clients/linear.js";
import { runInboxBatch } from "./worker/batch.js";
import { writeVaultNote } from "./vault/write.js";
import { applyLinearSync } from "./linear/apply.js";
import { upsertProjectNote } from "./vault/upsert.js";
import { loadProcessedState, saveProcessedState } from "./state/processed.js";
import { startWebhookServer } from "./server/webhook.js";
import { startLinearUnassignedRouter } from "./worker/route-linear-unassigned.js";
import { startUploadsWatcher } from "./worker/watch-uploads.js";
import { syncLinearIndex } from "./linear/index-cache.js";
import { runGranolaApiPollOnce, startGranolaApiPoller } from "./worker/granola-api-poller.js";

const configPath = join(process.cwd(), "integrations/ai-note-router/config/authority.yaml");
const dryRun = process.argv.includes("--dry-run");
const serve = process.argv.includes("--serve");
const replay = process.argv.includes("--replay");
const ingestManual = process.argv.includes("--ingest-manual");
const forceManual = process.argv.includes("--force");
const routeLinearUnassigned = process.argv.includes("--route-linear-unassigned");
const syncLinearIndexOnly = process.argv.includes("--sync-linear-index");
const pollGranolaApi = process.argv.includes("--poll-granola-api");
const inputFlagIndex = process.argv.indexOf("--input");
const inputPath = inputFlagIndex >= 0 ? process.argv[inputFlagIndex + 1] : null;
const portFlagIndex = process.argv.indexOf("--port");
const portValue = portFlagIndex >= 0 ? Number(process.argv[portFlagIndex + 1]) : Number(process.env.ROUTER_PORT || 3333);
const inboxFlagIndex = process.argv.indexOf("--inbox");
const inboxArg = inboxFlagIndex >= 0 ? process.argv[inboxFlagIndex + 1] : undefined;
const inboxDir = typeof inboxArg === "string" && inboxArg.length > 0
  ? inboxArg
  : join(process.cwd(), "integrations/ai-note-router/inbox");
const statePath = join(process.cwd(), "outputs/ai-note-router/processed-state.json");
const linearUnassignedIntervalMs = readOptionalNumberArg("--linear-unassigned-interval-ms", 5 * 60 * 1000);
const linearUnassignedLimit = readOptionalNumberArg("--linear-unassigned-limit", 50);
const granolaApiPollIntervalMinutes = readEnvNumber("GRANOLA_API_POLL_INTERVAL_MINUTES", 0);

logAudit({
  timestamp: new Date().toISOString(),
  stage: "startup",
  message: "AI note router scaffold loaded",
  payload: { configPath, dryRun, inputPath, replay, serve },
});

const routerConfig = loadRouterConfig(configPath);

if (syncLinearIndexOnly) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "linear-index",
      message: "Refusing to sync linear index: LINEAR_API_KEY is not set.",
    });
    process.exit(1);
  }
  const synced = await syncLinearIndex(process.cwd(), new LinearClient(apiKey));
  logAudit({
    timestamp: new Date().toISOString(),
    stage: "linear-index",
    message: "Synced local Linear index files.",
    payload: synced,
  });
  console.log(JSON.stringify(synced, null, 2));
  process.exit(0);
}

if (pollGranolaApi && !serve) {
  if (!process.env.GRANOLA_API_KEY) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "granola-api",
      message: "Refusing to run Granola API poll: GRANOLA_API_KEY is not set.",
    });
    process.exit(1);
  }
  await runGranolaApiPollOnce({
    workspaceRoot: process.cwd(),
    dryRun,
    intervalMinutes: Math.max(1, granolaApiPollIntervalMinutes || 1),
  });
  process.exit(0);
} else if (routeLinearUnassigned && !serve) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "linear-unassigned",
      message: "Refusing to run: LINEAR_API_KEY is not set.",
    });
    process.exit(1);
  }

  // One-shot run in this invocation (no interval).
  startLinearUnassignedRouter({
    workspaceRoot: process.cwd(),
    config: routerConfig,
    apiKey,
    dryRun,
    intervalMs: 60_000_000, // effectively disable subsequent ticks
    limit: linearUnassignedLimit,
  });

  // Let the initial tick finish before exiting.
  // (This is a best-effort; you should watch logs.)
  setTimeout(() => process.exit(0), 15_000);
} else if (serve) {
  const linearApiKey = process.env.LINEAR_API_KEY;
  if (linearApiKey) {
    try {
      const ok = await new LinearClient(linearApiKey).ping();
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "startup",
        message: ok ? "Linear API connection OK" : "Linear API check failed",
        payload: { linearConnected: ok },
      });
      const synced = await syncLinearIndex(process.cwd(), new LinearClient(linearApiKey));
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-index",
        message: "Synced local Linear index files at startup.",
        payload: synced,
      });
    } catch (err) {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "startup",
        message: "Linear API connection failed",
        payload: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  await startWebhookServer({
    workspaceRoot: process.cwd(),
    config: routerConfig,
    port: Number.isFinite(portValue) ? portValue : 3333,
    ...(process.env.ROUTER_HOST ? { host: process.env.ROUTER_HOST } : {}),
    dryRun,
    ...(linearApiKey ? { apiKey: linearApiKey } : {}),
  });

  const uploadsApiKey = process.env.LINEAR_API_KEY;
  void startUploadsWatcher({
    workspaceRoot: process.cwd(),
    config: routerConfig,
    dryRun,
    ...(uploadsApiKey ? { apiKey: uploadsApiKey } : {}),
  });

  if (routeLinearUnassigned) {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "linear-unassigned",
        message: "Linear unassigned router disabled: LINEAR_API_KEY not set.",
      });
    } else {
      startLinearUnassignedRouter({
        workspaceRoot: process.cwd(),
        config: routerConfig,
        apiKey,
        dryRun,
        intervalMs: linearUnassignedIntervalMs,
        limit: linearUnassignedLimit,
      });
    }
  }

  if (process.env.GRANOLA_API_KEY) {
    if (granolaApiPollIntervalMinutes > 0) {
      startGranolaApiPoller({
        workspaceRoot: process.cwd(),
        dryRun,
        intervalMinutes: granolaApiPollIntervalMinutes,
      });
    } else {
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "granola-api",
        message: "Granola API key detected; running one startup poll (set GRANOLA_API_POLL_INTERVAL_MINUTES > 0 for continuous polling).",
      });
      void runGranolaApiPollOnce({
        workspaceRoot: process.cwd(),
        dryRun,
        intervalMinutes: 1,
      }).catch((err) => {
        logAudit({
          timestamp: new Date().toISOString(),
          stage: "granola-api",
          message: "Granola API startup poll failed.",
          payload: { error: err instanceof Error ? err.message : String(err) },
        });
      });
    }
  }
} else if (inputPath) {
  const workspaceRoot = process.cwd();
  const note = loadNote(inputPath, routerConfig);
  const candidates = await loadLinearCandidates(routerConfig, note);
  const result = processNote(note, routerConfig, candidates, workspaceRoot);

  logAudit({
    timestamp: new Date().toISOString(),
    stage: "plan",
    message: "Computed initial routing plan",
    payload: result,
  });

  if (dryRun) {
    console.log(JSON.stringify({ routerConfig, note, result }, null, 2));
  } else {
    const written = writeVaultNote(workspaceRoot, result.vault);
    const projectNote = upsertProjectNote(workspaceRoot, result.note, result.route, result.dedupe.canonicalIssueId);
    const linearResult = await maybeApplyLinearSync(result.note, result.route, result.linear);
    console.log(JSON.stringify({ written, projectNote, linearResult }, null, 2));
  }
} else if (ingestManual) {
  const transcript = await readStdinText();
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) {
    console.error("No transcript received on stdin. Paste the transcript and pipe it in, e.g. `pbpaste | node ... --ingest-manual`.");
    process.exit(1);
  }
  const guardMessage = getManualTranscriptGuardMessage(trimmedTranscript);
  if (guardMessage && !forceManual) {
    console.error(
      `${guardMessage}\nPass --force to ingest anyway.\nExample: pbpaste | npm run ingest-manual -- --force`
    );
    process.exit(1);
  }

  const manualId = readOptionalStringArg("--id") ?? new Date().toISOString().replace(/[:.]/g, "-");
  const safeId = manualId.replace(/\s+/g, "-");
  const manualSource = parseManualSource(readOptionalStringArg("--source"));

  const payload: SourceInput = {
    source: manualSource,
    id: safeId,
    url: readOptionalStringArg("--url") ?? `manual://${safeId}`,
    title: readOptionalStringArg("--title") ?? deriveTitleFromTranscript(trimmedTranscript),
    body: trimmedTranscript,
  };

  const capturedAt = readOptionalStringArg("--capturedAt");
  if (capturedAt) payload.capturedAt = capturedAt;

  const client = readOptionalStringArg("--client");
  if (client) payload.client = client;

  const project = readOptionalStringArg("--project");
  if (project) payload.project = project;

  const team = readOptionalStringArg("--team");
  if (team) payload.team = team;

  const tagsRaw = readOptionalStringArg("--tags");
  if (tagsRaw) payload.tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);

  const peopleRaw = readOptionalStringArg("--people");
  if (peopleRaw) {
    payload.people = peopleRaw.split(",").map((n) => n.trim()).filter(Boolean).map((name) => ({ name }));
  } else {
    const inferredPeople = inferPeopleFromTranscript(trimmedTranscript);
    if (inferredPeople.length > 0) {
      payload.people = inferredPeople.map((name) => ({ name }));
    }
  }

  if (dryRun) {
    const workspaceRoot = process.cwd();
    const adapterContext = { extractor: routerConfig.extractor };
    const note = payload.source === "granola" ? granolaAdapter.load(payload, adapterContext) : firefliesAdapter.load(payload, adapterContext);
    const candidates = await loadLinearCandidates(routerConfig, note);
    const result = processNote(note, routerConfig, candidates, workspaceRoot);
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "manual-ingest",
      message: "Computed plan for manual transcript (dry-run)",
      payload: { id: payload.id },
    });
    console.log(JSON.stringify({ payload, result }, null, 2));
  } else {
    if (!existsSync(inboxDir)) {
      mkdirSync(inboxDir, { recursive: true });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const inboxFile = join(inboxDir, `${stamp}-${payload.source}-${payload.id}.json`);
    writeFileSync(inboxFile, JSON.stringify(payload, null, 2), "utf8");

    logAudit({
      timestamp: new Date().toISOString(),
      stage: "manual-ingest",
      message: "Queued manual transcript payload into inbox",
      payload: { inboxFile, id: payload.id },
    });

    const batch = await runInboxBatch(
      process.cwd(),
      inboxDir,
      statePath,
      routerConfig,
      dryRun,
      async (filePath) => loadNote(filePath, routerConfig),
      async (note, config, workspaceRoot) => {
        const candidates = await loadLinearCandidates(config, note);
        return processNote(note, config, candidates, workspaceRoot);
      }
    );

    logAudit({
      timestamp: new Date().toISOString(),
      stage: "manual",
      message: "Processed inbox after manual ingest",
      payload: { ...batch, mode: "manual" },
    });

    if (!dryRun) {
      const apiKey = process.env.LINEAR_API_KEY;
      const successfulFingerprints: string[] = [];
      if (apiKey) {
        const client = new LinearClient(apiKey);
        for (const item of batch.processed) {
          try {
            const projectNote = upsertProjectNote(process.cwd(), item.result.note, item.result.route, item.result.dedupe.canonicalIssueId);
            const linearResult = await applyLinearSync(client, item.result.note, item.result.route, item.result.linear);
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "linear",
              message: "Applied Linear sync plan",
              payload: { projectNote, linearResult },
            });
            successfulFingerprints.push(item.fingerprint);
          } catch (error) {
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "error",
              message: "Failed to apply router output",
              payload: {
                inputPath: item.inputPath,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      } else {
        for (const item of batch.processed) {
          try {
            const projectNote = upsertProjectNote(process.cwd(), item.result.note, item.result.route, item.result.dedupe.canonicalIssueId);
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "vault",
              message: "Updated Second Brain project note",
              payload: projectNote,
            });
            successfulFingerprints.push(item.fingerprint);
          } catch (error) {
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "error",
              message: "Failed to update Second Brain project note",
              payload: {
                inputPath: item.inputPath,
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
      }

      recordProcessedFingerprints(statePath, successfulFingerprints);
    }

    console.log(JSON.stringify(batch, null, 2));
  }
} else {
  const batch = await runInboxBatch(
    process.cwd(),
    inboxDir,
    statePath,
    routerConfig,
    dryRun,
    async (filePath) => loadNote(filePath),
    async (note, config, workspaceRoot) => {
      const candidates = await loadLinearCandidates(config, note);
      return processNote(note, config, candidates, workspaceRoot);
    }
  );

  logAudit({
    timestamp: new Date().toISOString(),
    stage: replay ? "replay" : "batch",
    message: replay ? "Replayed inbox batch" : "Processed inbox batch",
    payload: { ...batch, mode: replay ? "replay" : "batch" },
  });

  if (!dryRun) {
    const apiKey = process.env.LINEAR_API_KEY;
    const successfulFingerprints: string[] = [];
    if (apiKey) {
      const client = new LinearClient(apiKey);
      for (const item of batch.processed) {
        try {
          const projectNote = upsertProjectNote(process.cwd(), item.result.note, item.result.route, item.result.dedupe.canonicalIssueId);
          const linearResult = await applyLinearSync(client, item.result.note, item.result.route, item.result.linear);
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "linear",
            message: "Applied Linear sync plan",
            payload: { projectNote, linearResult },
          });
          successfulFingerprints.push(item.fingerprint);
        } catch (error) {
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "error",
            message: "Failed to apply router output",
            payload: {
              inputPath: item.inputPath,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    } else {
      for (const item of batch.processed) {
        try {
          const projectNote = upsertProjectNote(process.cwd(), item.result.note, item.result.route, item.result.dedupe.canonicalIssueId);
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "vault",
            message: "Updated Second Brain project note",
            payload: projectNote,
          });
          successfulFingerprints.push(item.fingerprint);
        } catch (error) {
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "error",
            message: "Failed to update Second Brain project note",
            payload: {
              inputPath: item.inputPath,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }

    recordProcessedFingerprints(statePath, successfulFingerprints);
  }

  console.log(JSON.stringify(batch, null, 2));
}

function loadNote(inputPath: string | null | undefined, config?: RouterConfig): CanonicalNote {
  if (inputPath && existsSync(inputPath)) {
    const parsed = JSON.parse(readFileSync(inputPath, "utf8")) as SourceInput;
    const context = config ? { extractor: config.extractor } : undefined;
    switch (parsed.source) {
      case "granola":
        return granolaAdapter.load(parsed, context);
      case "fireflies":
      default:
        return firefliesAdapter.load(parsed, context);
    }
  }

  return {
    source: {
      source: "fireflies",
      url: "https://example.com",
    },
    title: "Example note",
    body: "Placeholder note body",
    people: [],
    tasks: [],
    confidence: 1,
    tags: [],
    authority: {
      source: "fireflies",
    },
  };
}

async function loadLinearCandidates(routerConfig: RouterConfig, note: CanonicalNote) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey || !routerConfig.dedupe.enabled) {
    return [];
  }

  const client = new LinearClient(apiKey);
  return client.searchOpenIssueCandidates(note.team ?? null, note.project ?? null, note);
}

async function maybeApplyLinearSync(
  note: CanonicalNote,
  route: { team: string | null; project: string | null; reason: string },
  plan: { action: "create" | "update" | "skip"; issueId?: string; title: string; description: string; reason: string }
) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    return { action: "skip" as const, reason: "Skipping Linear write because LINEAR_API_KEY is not set." };
  }

  const client = new LinearClient(apiKey);
  return applyLinearSync(client, note, route, plan);
}

/** Merge newly processed fingerprints into the state file without dropping the skipped list the watcher maintains. */
function recordProcessedFingerprints(statePath: string, fingerprints: string[]): void {
  const existing = loadProcessedState(statePath);
  saveProcessedState(statePath, {
    processedFingerprints: Array.from(new Set([...existing.processedFingerprints, ...fingerprints])),
    skippedFingerprints: existing.skippedFingerprints,
  });
}

function readOptionalNumberArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return fallback;
  const raw = process.argv[idx + 1];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readOptionalStringArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return null;
  const raw = process.argv[idx + 1];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function deriveTitleFromTranscript(transcript: string): string {
  const firstLine = transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => Boolean(l)) ?? "Manual transcript";

  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

function getManualTranscriptGuardMessage(transcript: string): string | null {
  const compact = transcript.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  if (compact.length < 20) {
    return `Manual ingest blocked: stdin is very short (${compact.length} chars).`;
  }

  const commandLike = [
    "pbpaste",
    "npm run",
    "node ",
    "npx ",
    "cd ",
    "ls",
    "pwd",
    "echo ",
    "cat ",
    "curl ",
    "python ",
    "git ",
  ];
  if (commandLike.includes(lower) || commandLike.some((prefix) => lower.startsWith(prefix))) {
    return `Manual ingest blocked: stdin looks like a shell command ("${compact.slice(0, 80)}").`;
  }

  return null;
}

function inferPeopleFromTranscript(transcript: string): string[] {
  const lines = transcript.split(/\r?\n/).map((line) => line.trim());
  const maxHeaderScanLines = Math.min(lines.length, 40);
  const names = new Set<string>();

  for (let i = 0; i < maxHeaderScanLines; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const match = line.match(/^(meeting participants?|participants?|attendees?)\s*:\s*(.+)$/i);
    if (!match) continue;

    const rawList = match[2] ?? "";
    const candidates = rawList
      .split(/,|;|\band\b/gi)
      .map((value) => value.trim())
      .map((value) => value.replace(/\s*\([^)]*\)\s*$/g, "").trim())
      .filter(Boolean)
      .filter((value) => value.length > 1)
      .filter((value) => !/^me|them|speaker \d+|unknown$/i.test(value));

    for (const candidate of candidates) {
      if (!/[a-z]/i.test(candidate)) continue;
      names.add(candidate);
    }
  }

  return Array.from(names);
}

function parseManualSource(value: string | null): SourceName {
  if (!value) return "fireflies";
  const normalized = value.trim().toLowerCase();
  if (normalized === "granola") return "granola";
  if (normalized === "fireflies") return "fireflies";
  return "fireflies";
}
