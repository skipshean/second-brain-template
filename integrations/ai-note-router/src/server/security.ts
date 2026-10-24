import { timingSafeEqual } from "crypto";

/** Make a payload id safe to embed in an inbox filename (no path separators or dots). */
export function sanitizeSourceId(id: unknown): string {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "-");
  return cleaned.replace(/^-+$/, "") || "note";
}

/** Render a value as a single-line, double-quoted YAML scalar. */
export function yamlQuote(value: string): string {
  return JSON.stringify(value.replace(/[\r\n\u2028\u2029]+/g, " "));
}

export type TokenCheck = { ok: true } | { ok: false; status: 401 | 403; error: string };

/**
 * Fail closed: with no secret configured, ingest is refused unless the operator
 * explicitly opts in via `allowUnauthenticated` (ROUTER_ALLOW_UNAUTHENTICATED=1).
 */
export function checkWebhookToken(
  source: string,
  secret: string | undefined,
  provided: string | string[] | undefined,
  allowUnauthenticated: boolean
): TokenCheck {
  if (!secret) {
    return allowUnauthenticated
      ? { ok: true }
      : { ok: false, status: 403, error: `No webhook secret configured for ${source}; set it in .env` };
  }
  if (typeof provided !== "string" || provided.trim() === "") {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** True only for a direct loopback connection with no proxy/tunnel forwarding headers. */
export function isDirectLoopback(remoteAddress: string | undefined, headers: HeaderBag): boolean {
  const loop = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
  if (!loop) return false;
  return !["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"].some((h) => headers[h] !== undefined);
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/** Defends against DNS rebinding: the Host header must be a literal local name. */
export function isLocalHostHeader(host: unknown): boolean {
  return typeof host === "string" && LOCAL_HOST_RE.test(host);
}

/**
 * Browser CSRF / DNS-rebinding guard for local-only endpoints: Host must be a
 * literal local name, and any Origin must match that Host.
 */
export function isSameOriginOrNonBrowser(headers: HeaderBag): boolean {
  const host = headers["host"];
  if (!isLocalHostHeader(host)) return false;
  const origin = headers["origin"];
  if (origin === undefined) {
    const site = headers["sec-fetch-site"];
    return site === undefined || site === "same-origin" || site === "none";
  }
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
