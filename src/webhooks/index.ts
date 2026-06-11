/**
 * Webhook signature verification.
 *
 * Sub-plan 21.1 row B-5. THE single most important utility this SDK
 * ships: every webhook consumer drops this call into the top of their
 * HTTP handler before touching the body.
 *
 * Wire format (mirrors apps/worker/src/adapters/webhook.ts):
 *
 *   X-Blockchain0x-Timestamp: <unix seconds>
 *   X-Blockchain0x-Signature: t=<timestamp>,v1=<hex>
 *   X-Blockchain0x-Event-Type: <type slug>
 *   X-Blockchain0x-Event-Id: <ulid>
 *   X-Blockchain0x-Delivery-Id: webhook_<id>
 *
 * Algorithm:
 *
 *   want = HMAC-SHA256(secret, `${t}.${rawBody}`).digest('hex')
 *   ok   = timingSafeEqual(want, v1) && |now - t| <= toleranceSec
 *
 * Discriminated-union return shape so callers branch on `ok` without a
 * try/catch:
 *
 *   const r = webhooks.verify({ headers, rawBody, secret });
 *   if (!r.ok) return res.status(400).json({ code: r.code });
 *   // r.eventType / r.eventId / r.deliveryId are populated.
 *
 * The verifier accepts EITHER the structured `t=...,v1=...` header OR a
 * bare hex string in the signature header (some load balancers strip
 * comma-delimited values); when bare-hex, the `t` value is read from
 * the X-Blockchain0x-Timestamp header.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from '../errors.js';

const SIG_HEADER = 'x-blockchain0x-signature';
const TS_HEADER = 'x-blockchain0x-timestamp';
const TYPE_HEADER = 'x-blockchain0x-event-type';
const EVENT_ID_HEADER = 'x-blockchain0x-event-id';
const DELIVERY_ID_HEADER = 'x-blockchain0x-delivery-id';

const DEFAULT_TOLERANCE_SEC = 300; // 5 minutes; matches the worker.

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface VerifyArgs {
  headers: WebhookHeaders;
  /** The raw HTTP body as it arrived on the wire. */
  rawBody: Buffer | string;
  /** The signing secret from the dashboard. */
  secret: string;
  /**
   * Maximum age of `t=` against the verifier's clock, in seconds.
   * Defaults to 300 (matches the worker's 5-minute replay window).
   */
  toleranceSec?: number;
  /** Override for tests. Defaults to `() => Math.floor(Date.now() / 1000)`. */
  now?: () => number;
}

export interface VerifyOk {
  ok: true;
  /** The X-Blockchain0x-Event-Type slug, when the server included it. */
  eventType: string;
  /** The X-Blockchain0x-Event-Id, when the server included it. */
  eventId: string;
  /** The X-Blockchain0x-Delivery-Id (e.g. `webhook_<id>`). */
  deliveryId: string;
}

export interface VerifyFail {
  ok: false;
  code: WebhookSignatureError['code'];
}

export type VerifyResult = VerifyOk | VerifyFail;

function pickHeader(headers: WebhookHeaders, name: string): string | undefined {
  // Normalise lookup: HTTP frameworks often lowercase header keys, but
  // some pass them through verbatim. Try lowercase first (the common
  // Node convention) then fall back to the supplied casing.
  const direct = headers[name];
  const v =
    direct ??
    headers[name.toLowerCase()] ??
    headers[name.toUpperCase()] ??
    Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
  if (Array.isArray(v)) {
    return v[0];
  }
  return typeof v === 'string' ? v : undefined;
}

/**
 * Parse `t=<ts>,v1=<hex>` (possibly with whitespace between fields).
 * Returns null when the header is missing both halves. When `v1=...`
 * appears alone (no `t=`), the caller falls back to the timestamp
 * header.
 */
function parseSigHeader(value: string): { t?: string; v1?: string } | null {
  const parts = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) {
    return null;
  }
  const out: { t?: string; v1?: string } = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      // Bare hex (load balancer stripped the structured form). Treat
      // the entire value as v1.
      if (/^[0-9a-fA-F]+$/.test(part)) {
        out.v1 = part;
      }
      continue;
    }
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key === 't') {
      out.t = val;
    } else if (key === 'v1') {
      out.v1 = val;
    }
  }
  return out;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  // timingSafeEqual rejects unequal-length buffers - the length guard
  // above keeps the comparison constant-time WITHIN equal-length pairs.
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function verify(args: VerifyArgs): VerifyResult {
  // Sub-plan 21.3 C-8 parity tightening: empty secret rejects up
  // front (was previously collapsed into signature_mismatch via the
  // HMAC of an empty key).
  if (!args.secret) {
    return { ok: false, code: 'webhook.secret_missing' };
  }
  const sigHeader = pickHeader(args.headers, SIG_HEADER);
  if (!sigHeader) {
    return { ok: false, code: 'webhook.signature_missing' };
  }
  const parsed = parseSigHeader(sigHeader);
  if (!parsed || !parsed.v1) {
    return { ok: false, code: 'webhook.signature_malformed' };
  }

  // Pull `t=` from the signature header if present, else the dedicated
  // timestamp header.
  const tsStr = parsed.t ?? pickHeader(args.headers, TS_HEADER);
  if (!tsStr) {
    return { ok: false, code: 'webhook.timestamp_missing' };
  }
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || ts <= 0) {
    // Sub-plan 21.3 C-8: non-numeric / non-positive `t=` is its own
    // code now (was previously collapsed into timestamp_missing).
    return { ok: false, code: 'webhook.timestamp_invalid' };
  }
  const tolerance = args.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = (args.now ?? defaultNow)();
  if (Math.abs(now - ts) > tolerance) {
    return { ok: false, code: 'webhook.timestamp_outside_window' };
  }

  const bodyBytes =
    typeof args.rawBody === 'string' ? Buffer.from(args.rawBody, 'utf8') : args.rawBody;
  const want = createHmac('sha256', args.secret).update(`${ts}.`).update(bodyBytes).digest('hex');

  if (!constantTimeHexEqual(want, parsed.v1)) {
    return { ok: false, code: 'webhook.signature_mismatch' };
  }

  return {
    ok: true,
    eventType: pickHeader(args.headers, TYPE_HEADER) ?? '',
    eventId: pickHeader(args.headers, EVENT_ID_HEADER) ?? '',
    deliveryId: pickHeader(args.headers, DELIVERY_ID_HEADER) ?? '',
  };
}

function defaultNow(): number {
  return Math.floor(Date.now() / 1000);
}

export { WebhookSignatureError };
