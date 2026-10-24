import test from "node:test";
import assert from "node:assert/strict";
import { checkWebhookToken, isDirectLoopback, isSameOriginOrNonBrowser, sanitizeSourceId, yamlQuote } from "./security.js";

test("sanitizeSourceId strips path traversal and separators", () => {
  assert.equal(sanitizeSourceId("../../etc/passwd"), "------etc-passwd");
  assert.ok(!sanitizeSourceId("../../x").includes("/"));
  assert.ok(!sanitizeSourceId("a\\b.json").includes("\\"));
  assert.equal(sanitizeSourceId("01KABC_def-9"), "01KABC_def-9");
});

test("sanitizeSourceId falls back for empty or all-separator ids", () => {
  assert.equal(sanitizeSourceId(""), "note");
  assert.equal(sanitizeSourceId(undefined), "note");
  assert.equal(sanitizeSourceId("///"), "note");
});

test("yamlQuote cannot be broken out of by newlines or quotes", () => {
  const out = yamlQuote('a@b.com\ntype: admin\r\n"x"');
  assert.ok(!/[\r\n]/.test(out));
  assert.equal(JSON.parse(out), 'a@b.com type: admin "x"');
});

test("checkWebhookToken fails closed without a secret", () => {
  const r = checkWebhookToken("fireflies", undefined, undefined, false);
  assert.equal(r.ok, false);
  assert.equal(checkWebhookToken("fireflies", undefined, undefined, true).ok, true);
});

test("checkWebhookToken rejects missing, wrong, and wrong-length tokens; accepts exact", () => {
  assert.equal(checkWebhookToken("granola", "s3cret", undefined, false).ok, false);
  assert.equal(checkWebhookToken("granola", "s3cret", "s3cre", false).ok, false);
  assert.equal(checkWebhookToken("granola", "s3cret", "xxxxxx", false).ok, false);
  assert.equal(checkWebhookToken("granola", "s3cret", ["s3cret"], false).ok, false);
  assert.equal(checkWebhookToken("granola", "s3cret", "s3cret", false).ok, true);
});

test("isDirectLoopback rejects tunneled/proxied loopback connections", () => {
  assert.equal(isDirectLoopback("127.0.0.1", {}), true);
  assert.equal(isDirectLoopback("::1", {}), true);
  assert.equal(isDirectLoopback("127.0.0.1", { "cf-connecting-ip": "1.2.3.4" }), false);
  assert.equal(isDirectLoopback("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }), false);
  assert.equal(isDirectLoopback("10.0.0.5", {}), false);
});

test("isSameOriginOrNonBrowser blocks cross-site browser posts", () => {
  assert.equal(isSameOriginOrNonBrowser({ host: "localhost:3333", origin: "http://localhost:3333" }), true);
  assert.equal(isSameOriginOrNonBrowser({ host: "localhost:3333", origin: "https://evil.example" }), false);
  assert.equal(isSameOriginOrNonBrowser({ host: "localhost:3333", "sec-fetch-site": "cross-site" }), false);
  assert.equal(isSameOriginOrNonBrowser({ host: "localhost:3333" }), true);
});

test("isSameOriginOrNonBrowser rejects DNS-rebinding hosts even when Origin matches Host", () => {
  assert.equal(isSameOriginOrNonBrowser({ host: "evil.example:3333", origin: "http://evil.example:3333" }), false);
  assert.equal(isSameOriginOrNonBrowser({ host: "evil.example" }), false);
  assert.equal(isSameOriginOrNonBrowser({ host: "127.0.0.1:3333", origin: "http://127.0.0.1:3333" }), true);
  assert.equal(isSameOriginOrNonBrowser({ host: "[::1]:3333" }), true);
  assert.equal(isSameOriginOrNonBrowser({}), false);
});
