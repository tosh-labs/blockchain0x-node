/**
 * Tests for `webhooks.verify` (sub-plan 21.1 row B-5).
 *
 * Hits every branch in the discriminated-union return shape:
 *   - signature_missing (no header at all)
 *   - signature_malformed (header present but no `v1=` and no bare hex)
 *   - timestamp_missing (no t= in sig header AND no X-...-Timestamp)
 *   - timestamp_outside_window (5-minute replay window)
 *   - signature_mismatch (HMAC disagrees)
 *   - ok: true (happy path; bare-hex variant; case-insensitive headers)
 *
 * Mirrors the worker's signing scheme exactly (apps/worker/src/adapters/
 * webhook.ts). A regression in either side would surface as a
 * `signature_mismatch` here.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verify } from './index.js';

const SECRET = 'whsk_test_demo_secret_value';
const NOW = 1_750_000_000;
const BODY = JSON.stringify({
  id: 'evt_01HQX5',
  type: 'payment.received',
  deliveryId: 'webhook_wh_01',
  data: { amount: '12.50' },
});

function sign(ts: number, body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function freshHeaders(ts: number = NOW): Record<string, string> {
  const sig = sign(ts, BODY);
  return {
    'x-blockchain0x-signature': `t=${ts},v1=${sig}`,
    'x-blockchain0x-timestamp': String(ts),
    'x-blockchain0x-event-type': 'payment.received',
    'x-blockchain0x-event-id': 'evt_01HQX5',
    'x-blockchain0x-delivery-id': 'webhook_wh_01',
  };
}

const now = () => NOW;

describe('webhooks.verify - happy path', () => {
  it('returns ok with event metadata when signature + timestamp agree', () => {
    const res = verify({
      headers: freshHeaders(),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({
      ok: true,
      eventType: 'payment.received',
      eventId: 'evt_01HQX5',
      deliveryId: 'webhook_wh_01',
    });
  });

  it('accepts rawBody as a Buffer (not just a string)', () => {
    const res = verify({
      headers: freshHeaders(),
      rawBody: Buffer.from(BODY, 'utf8'),
      secret: SECRET,
      now,
    });
    expect(res.ok).toBe(true);
  });

  it('is case-insensitive on header names (Express-style PascalCase)', () => {
    const lower = freshHeaders();
    const mixed: Record<string, string> = {};
    for (const [k, v] of Object.entries(lower)) {
      const camel = k
        .split('-')
        .map((s, i) => (i === 0 ? s.toLowerCase() : s[0]!.toUpperCase() + s.slice(1)))
        .join('-');
      mixed[camel] = v;
    }
    const res = verify({ headers: mixed, rawBody: BODY, secret: SECRET, now });
    expect(res.ok).toBe(true);
  });

  it('accepts a bare-hex Signature header when the LB stripped the t= prefix', () => {
    const ts = NOW;
    const sig = sign(ts, BODY);
    const res = verify({
      headers: {
        'x-blockchain0x-signature': sig,
        'x-blockchain0x-timestamp': String(ts),
      },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res.ok).toBe(true);
  });
});

describe('webhooks.verify - failure codes', () => {
  it('signature_missing when the header is absent', () => {
    const res = verify({
      headers: {},
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.signature_missing' });
  });

  it('signature_malformed when neither v1 nor a bare hex is present', () => {
    const res = verify({
      headers: { 'x-blockchain0x-signature': 't=1234,unrelated=value' },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.signature_malformed' });
  });

  it('webhook.timestamp_missing when no t= nor X-...-Timestamp header is present', () => {
    const ts = NOW;
    const sig = sign(ts, BODY);
    const res = verify({
      headers: { 'x-blockchain0x-signature': `v1=${sig}` },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.timestamp_missing' });
  });

  // Sub-plan 21.3 C-8: split from timestamp_missing. A non-numeric
  // `t=` value now returns webhook.timestamp_invalid instead of
  // collapsing into the "no timestamp at all" code.
  it('webhook.timestamp_invalid when the timestamp is not an integer', () => {
    const ts = NOW;
    const sig = sign(ts, BODY);
    const res = verify({
      headers: {
        'x-blockchain0x-signature': `v1=${sig}`,
        'x-blockchain0x-timestamp': 'not-a-number',
      },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.timestamp_invalid' });
  });

  // Sub-plan 21.3 C-8: split from signature_mismatch (the HMAC of
  // an empty key path). An empty secret rejects up front with
  // webhook.secret_missing - the caller forgot to wire env.
  it('webhook.secret_missing when the secret is an empty string', () => {
    const ts = NOW;
    const sig = sign(ts, BODY);
    const res = verify({
      headers: { 'x-blockchain0x-signature': `t=${ts},v1=${sig}` },
      rawBody: BODY,
      secret: '',
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.secret_missing' });
  });

  it('timestamp_outside_window when the request is older than tolerance', () => {
    const stale = NOW - 6 * 60; // 6 minutes - the default tolerance is 5
    const res = verify({
      headers: freshHeaders(stale),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.timestamp_outside_window' });
  });

  it('timestamp_outside_window also rejects far-future timestamps', () => {
    const future = NOW + 6 * 60;
    const res = verify({
      headers: freshHeaders(future),
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.timestamp_outside_window' });
  });

  it('signature_mismatch when the secret is wrong', () => {
    const res = verify({
      headers: freshHeaders(),
      rawBody: BODY,
      secret: 'whsk_WRONG_SECRET',
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.signature_mismatch' });
  });

  it('signature_mismatch when even a single body byte is tampered', () => {
    const tampered = BODY.replace('12.50', '12.51');
    const res = verify({
      headers: freshHeaders(),
      rawBody: tampered,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.signature_mismatch' });
  });

  it('honors a custom toleranceSec when supplied (10s window rejects 11s old)', () => {
    const stale = NOW - 11;
    const res = verify({
      headers: freshHeaders(stale),
      rawBody: BODY,
      secret: SECRET,
      toleranceSec: 10,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.timestamp_outside_window' });
  });
});

describe('webhooks.verify - constant-time compare', () => {
  it('returns signature_mismatch for hex strings of different lengths', () => {
    const ts = NOW;
    const res = verify({
      headers: {
        'x-blockchain0x-signature': `t=${ts},v1=abc`,
        'x-blockchain0x-timestamp': String(ts),
      },
      rawBody: BODY,
      secret: SECRET,
      now,
    });
    expect(res).toEqual({ ok: false, code: 'webhook.signature_mismatch' });
  });
});
