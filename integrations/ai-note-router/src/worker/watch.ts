import { existsSync, mkdirSync, readdirSync, watch } from "fs";
import { join } from "path";
import type { RouterConfig } from "../config/types.js";
import type { CanonicalNote } from "../normalize/note.js";
import { loadCanonicalNoteFromFile } from "../sources/load.js";
import { getNoteFingerprint } from "../normalize/fingerprint.js";
import { loadProcessedState, saveProcessedState, type SkippedFingerprint } from "../state/processed.js";
import { executeNote } from "./execute.js";
import { logAudit } from "../audit/log.js";
import { classifyProcessingError, computeRateLimitPauseUntil, RetrySchedule } from "./failure-policy.js";

export type InboxWatcherOptions = {
  workspaceRoot: string;
  inboxDir: string;
  statePath: string;
  config: RouterConfig;
  dryRun: boolean;
  apiKey?: string;
  pollIntervalMs?: number;
  /** Minimum wait before a transiently failed payload is retried (doubles per failure). Default 5 minutes. */
  retryBaseDelayMs?: number;
  /** Cap on the per-payload retry wait. Default 6 hours. */
  retryMaxDelayMs?: number;
  /** Injection point for tests; defaults to the real executeNote. */
  executeNoteFn?: typeof executeNote;
};

const DEFAULT_RETRY_BASE_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

export type InboxWatcherHandle = {
  active: boolean;
  stop(): Promise<void>;
};

export function hasConnectedInboundSource(config: RouterConfig): boolean {
  const fireflies = config.sources.fireflies.enabled && (config.sources.fireflies.connected === true);
  const granola = config.sources.granola.enabled && (config.sources.granola.connected === true);
  return fireflies || granola;
}

export async function startInboxWatcher(options: InboxWatcherOptions): Promise<InboxWatcherHandle> {
  if (!hasConnectedInboundSource(options.config)) {
    logAudit({
      timestamp: new Date().toISOString(),
      stage: "watch",
      message: "Inbox watcher disabled: no inbound source has enabled and connected in config",
      payload: {
        fireflies: {
          enabled: options.config.sources.fireflies.enabled,
          connected: options.config.sources.fireflies.connected === true,
        },
        granola: {
          enabled: options.config.sources.granola.enabled,
          connected: options.config.sources.granola.connected === true,
        },
      },
    });

    return {
      active: false,
      stop: async () => {},
    };
  }

  ensureDirectory(options.inboxDir);

  const processedState = loadProcessedState(options.statePath);
  const processedFingerprints = new Set(processedState.processedFingerprints);
  const skippedFingerprints: SkippedFingerprint[] = [...processedState.skippedFingerprints];
  const skippedSet = new Set(skippedFingerprints.map((entry) => entry.fingerprint));
  const retrySchedule = new RetrySchedule({
    baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs: options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
  });
  const execute = options.executeNoteFn ?? executeNote;
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  let stopped = false;
  let scanning = false;
  let rescanRequested = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  /** While set (epoch ms), scans are skipped: the Linear hourly budget is exhausted. */
  let pausedUntil: number | null = null;

  const persistState = (): void => {
    saveProcessedState(options.statePath, {
      processedFingerprints: Array.from(processedFingerprints),
      skippedFingerprints,
    });
  };

  const scheduleScan = (): void => {
    if (stopped) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      void scan();
    }, 250);
  };

  const scan = async (): Promise<void> => {
    if (stopped) {
      return;
    }

    if (scanning) {
      rescanRequested = true;
      return;
    }

    if (pausedUntil !== null) {
      if (Date.now() < pausedUntil) {
        return;
      }
      logAudit({
        timestamp: new Date().toISOString(),
        stage: "watch",
        message: "Linear rate-limit pause ended; resuming inbox scans",
        payload: { pausedUntil: new Date(pausedUntil).toISOString() },
      });
      pausedUntil = null;
    }

    scanning = true;
    try {
      const files = listInboxFiles(options.inboxDir);
      for (const filePath of files) {
        if (stopped) {
          break;
        }

        let note: CanonicalNote;
        try {
          note = loadCanonicalNoteFromFile(filePath, { extractor: options.config.extractor });
        } catch (error) {
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "error",
            message: "Failed to load inbox payload",
            payload: {
              filePath,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          continue;
        }

        const fingerprint = getNoteFingerprint(note);
        if (processedFingerprints.has(fingerprint) || skippedSet.has(fingerprint)) {
          continue;
        }

        if (!retrySchedule.shouldAttempt(fingerprint, Date.now())) {
          continue;
        }

        try {
          const apiKey = options.apiKey || process.env.LINEAR_API_KEY;
          const execution = await execute(note, options.config, {
            workspaceRoot: options.workspaceRoot,
            dryRun: options.dryRun,
            ...(apiKey ? { apiKey } : {}),
          });

          logAudit({
            timestamp: new Date().toISOString(),
            stage: "watch",
            message: "Processed inbox payload",
            payload: {
              filePath,
              fingerprint,
              execution,
            },
          });

          retrySchedule.recordSuccess(fingerprint);
          if (!options.dryRun) {
            processedFingerprints.add(fingerprint);
            persistState();
          }
        } catch (error) {
          const failure = classifyProcessingError(error);

          if (failure.kind === "rate-limited") {
            // Every further attempt this scan would be rejected too; stop now and
            // wait for the window to reset instead of burning the budget on retries.
            pausedUntil = computeRateLimitPauseUntil(error, Date.now());
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "watch",
              message: "Linear rate limit exceeded; pausing inbox scans until the window resets",
              payload: {
                filePath,
                fingerprint,
                pausedUntil: new Date(pausedUntil).toISOString(),
                error: failure.message,
              },
            });
            break;
          }

          if (failure.kind === "terminal") {
            // Permanent failure (e.g. retired Linear team): record once, never retry.
            const entry: SkippedFingerprint = {
              fingerprint,
              reason: failure.message,
              skippedAt: new Date().toISOString(),
              filePath,
            };
            skippedFingerprints.push(entry);
            skippedSet.add(fingerprint);
            if (!options.dryRun) {
              persistState();
            }
            logAudit({
              timestamp: new Date().toISOString(),
              stage: "watch",
              message: "Inbox payload failed permanently; recorded as skipped and will not be retried",
              payload: { filePath, fingerprint, error: failure.message },
            });
            continue;
          }

          const backoff = retrySchedule.recordFailure(fingerprint, Date.now());
          logAudit({
            timestamp: new Date().toISOString(),
            stage: "error",
            message: "Failed to process inbox payload",
            payload: {
              filePath,
              fingerprint,
              error: failure.message,
              failures: backoff.failures,
              nextAttemptAt: new Date(backoff.nextAttemptAt).toISOString(),
            },
          });
        }
      }
    } finally {
      scanning = false;
      if (rescanRequested && !stopped) {
        rescanRequested = false;
        await scan();
      }
    }
  };

  const initialFiles = listInboxFiles(options.inboxDir);
  logAudit({
    timestamp: new Date().toISOString(),
    stage: "watch",
    message: "Inbox watcher started; watching for new payloads",
    payload: {
      inboxDir: options.inboxDir,
      inboxFileCount: initialFiles.length,
    },
  });

  const watcher = watch(options.inboxDir, { persistent: true }, (eventType, filename) => {
    if (eventType === "change" || eventType === "rename" || filename) {
      scheduleScan();
    }
  });

  const interval = setInterval(() => {
    scheduleScan();
  }, pollIntervalMs);

  await scan();

  return {
    active: true,
    stop: async () => {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      clearInterval(interval);
      watcher.close();
    },
  };
}

function listInboxFiles(inboxDir: string): string[] {
  if (!existsSync(inboxDir)) {
    return [];
  }

  return readdirSync(inboxDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => join(inboxDir, file))
    .sort();
}

function ensureDirectory(directory: string): void {
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
}
