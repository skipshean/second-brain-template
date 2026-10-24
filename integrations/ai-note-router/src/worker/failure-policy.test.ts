import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProcessingError,
  computeRateLimitPauseUntil,
  parseRateLimitResetHeader,
  RetrySchedule,
} from "./failure-policy.js";

test("classifies Linear 'Entity is retired' as terminal", () => {
  const error = new Error("Linear API errors: Entity is retired: team");
  assert.equal(classifyProcessingError(error).kind, "terminal");
});

test("classifies Linear rate-limit body (HTTP 400) as rate-limited", () => {
  const error = new Error(
    'Linear API error 400: {"errors":[{"message":"Rate limit exceeded. Only 2500 requests are allowed per 1 hour."}]}'
  );
  assert.equal(classifyProcessingError(error).kind, "rate-limited");
});

test("classifies HTTP 429 as rate-limited", () => {
  const error = new Error("Linear API error 429: too many");
  (error as { status?: number }).status = 429;
  assert.equal(classifyProcessingError(error).kind, "rate-limited");
});

test("classifies any other failure as transient", () => {
  assert.equal(classifyProcessingError(new Error("fetch failed")).kind, "transient");
  assert.equal(classifyProcessingError("boom").kind, "transient");
});

test("pauses until the Linear reset timestamp when the error carries one", () => {
  const now = Date.UTC(2026, 9, 17, 15, 10, 0);
  const error = new Error("Rate limit exceeded");
  (error as { rateLimitResetAt?: number }).rateLimitResetAt = now + 12 * 60_000;
  assert.equal(computeRateLimitPauseUntil(error, now), now + 12 * 60_000);
});

test("pauses until the next hour boundary when no reset timestamp is known", () => {
  const now = Date.UTC(2026, 9, 17, 15, 10, 0);
  assert.equal(computeRateLimitPauseUntil(new Error("Rate limit exceeded"), now), Date.UTC(2026, 9, 17, 16, 0, 0));
});

test("ignores a reset timestamp that is already in the past", () => {
  const now = Date.UTC(2026, 9, 17, 15, 10, 0);
  const error = new Error("Rate limit exceeded");
  (error as { rateLimitResetAt?: number }).rateLimitResetAt = now - 1000;
  assert.equal(computeRateLimitPauseUntil(error, now), Date.UTC(2026, 9, 17, 16, 0, 0));
});

test("parses Linear reset header in epoch milliseconds or seconds", () => {
  assert.equal(parseRateLimitResetHeader("1760713200000"), 1760713200000);
  assert.equal(parseRateLimitResetHeader("1760713200"), 1760713200000);
  assert.equal(parseRateLimitResetHeader(null), undefined);
  assert.equal(parseRateLimitResetHeader("nope"), undefined);
});

test("retry schedule blocks a failed fingerprint for a growing window", () => {
  const schedule = new RetrySchedule({ baseDelayMs: 5 * 60_000, maxDelayMs: 60 * 60_000 });
  const t0 = 1_000_000;
  assert.equal(schedule.shouldAttempt("fp", t0), true);
  schedule.recordFailure("fp", t0);
  assert.equal(schedule.shouldAttempt("fp", t0 + 4 * 60_000), false);
  assert.equal(schedule.shouldAttempt("fp", t0 + 5 * 60_000), true);
  schedule.recordFailure("fp", t0 + 5 * 60_000);
  assert.equal(schedule.shouldAttempt("fp", t0 + 5 * 60_000 + 9 * 60_000), false);
  assert.equal(schedule.shouldAttempt("fp", t0 + 5 * 60_000 + 10 * 60_000), true);
});

test("retry schedule caps the delay and clears on success", () => {
  const schedule = new RetrySchedule({ baseDelayMs: 60_000, maxDelayMs: 150_000 });
  const t0 = 0;
  for (let i = 0; i < 6; i += 1) schedule.recordFailure("fp", t0);
  assert.equal(schedule.shouldAttempt("fp", t0 + 149_000), false);
  assert.equal(schedule.shouldAttempt("fp", t0 + 150_000), true);
  schedule.recordSuccess("fp");
  schedule.recordFailure("fp", t0);
  assert.equal(schedule.shouldAttempt("fp", t0 + 60_000), true);
});
