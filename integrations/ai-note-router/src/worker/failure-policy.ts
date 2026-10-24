/**
 * Decides how the inbox watcher should react to a processing failure so one
 * bad payload cannot starve the Linear hourly request budget (2500/hour).
 */

export type FailureKind = "terminal" | "rate-limited" | "transient";

export type ClassifiedFailure = {
  kind: FailureKind;
  message: string;
};

const TERMINAL_PATTERNS = [/entity is retired/i];
const RATE_LIMIT_PATTERNS = [/rate limit exceeded/i, /ratelimited/i];

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

export function isRateLimitError(error: unknown): boolean {
  if (errorStatus(error) === 429) return true;
  const message = errorMessage(error);
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

export function classifyProcessingError(error: unknown): ClassifiedFailure {
  const message = errorMessage(error);
  if (TERMINAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return { kind: "terminal", message };
  }
  if (isRateLimitError(error)) {
    return { kind: "rate-limited", message };
  }
  return { kind: "transient", message };
}

/** Linear sends `X-RateLimit-Requests-Reset` as an epoch timestamp (ms, historically seconds). */
export function parseRateLimitResetHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  // Anything below 1e12 cannot be a millisecond epoch in this century; treat as seconds.
  return parsed < 1e12 ? parsed * 1000 : parsed;
}

export function nextHourBoundary(now: number): number {
  const hour = 60 * 60 * 1000;
  return (Math.floor(now / hour) + 1) * hour;
}

/**
 * When the limit window should reset. Prefers the reset timestamp attached to
 * the error (from Linear's response headers); otherwise waits for the next
 * clock-hour boundary.
 */
export function computeRateLimitPauseUntil(error: unknown, now: number): number {
  if (typeof error === "object" && error !== null && "rateLimitResetAt" in error) {
    const resetAt = Number((error as { rateLimitResetAt?: unknown }).rateLimitResetAt);
    if (Number.isFinite(resetAt) && resetAt > now) {
      return resetAt;
    }
  }
  return nextHourBoundary(now);
}

export type RetryScheduleOptions = {
  baseDelayMs: number;
  maxDelayMs: number;
};

/** In-memory exponential backoff keyed by note fingerprint. */
export class RetrySchedule {
  private readonly entries = new Map<string, { failures: number; nextAttemptAt: number }>();

  constructor(private readonly options: RetryScheduleOptions) {}

  shouldAttempt(fingerprint: string, now: number): boolean {
    const entry = this.entries.get(fingerprint);
    return !entry || now >= entry.nextAttemptAt;
  }

  recordFailure(fingerprint: string, now: number): { failures: number; nextAttemptAt: number } {
    const failures = (this.entries.get(fingerprint)?.failures ?? 0) + 1;
    const delay = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** (failures - 1));
    const entry = { failures, nextAttemptAt: now + delay };
    this.entries.set(fingerprint, entry);
    return entry;
  }

  recordSuccess(fingerprint: string): void {
    this.entries.delete(fingerprint);
  }
}
