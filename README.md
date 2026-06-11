# @blockchain0x/node

[![npm version](https://img.shields.io/npm/v/@blockchain0x/node/alpha.svg)](https://www.npmjs.com/package/@blockchain0x/node)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](#requirements)

**Official Node.js + TypeScript SDK for [Blockchain0x](https://blockchain0x.com)** - the non-custodial AI-agent wallet platform on Base. Authenticate as an agent, read balances + transactions, request stablecoin payments, manage webhooks, and verify inbound webhook signatures in production.

> Pre-release: `0.1.0-alpha.x` ships the production agent surface (`agents`, `apiKeys`, `webhooks`, `payments`, and `webhooks.verify`). The full surface (browser bundle, React hooks, Python sibling) is on the roadmap below.

## Why this SDK

- **TypeScript first.** Full types for every request, response, and error code - inferred from the OpenAPI spec, no `any` shortcuts.
- **Production-grade transport.** Automatic retry on 5xx + 429 with exponential backoff and `Retry-After` honoured. `POST /v1/payments` is opt-in for retries (idempotency-safe by default).
- **Structured errors.** `ApiKeyError` vs `Blockchain0xError` discriminated union with stable code strings (`apikey.scope_insufficient`, `apikey.agent_mismatch`, etc.) so your business logic can switch on the wire-level contract instead of regex-matching messages.
- **HMAC webhook verification.** The single most important utility we ship - `webhooks.verify` is the same code path our worker uses to sign, byte-for-byte. Constant-time comparison, 5-minute replay window, discriminated-union result so you branch on `ok` without a try/catch.
- **Idempotency built in.** `payments.create` auto-mints a stable `Idempotency-Key` so retries collapse to one chain submission. Override it when you want to dedupe across processes.

## Requirements

- Node.js 18 or newer (uses native `fetch` + `AbortController`).
- A Blockchain0x workspace + an API key (mint one in your dashboard at https://app.blockchain0x.com).

## Install

```bash
npm install @blockchain0x/node@alpha
# or
pnpm add @blockchain0x/node@alpha
# or
yarn add @blockchain0x/node@alpha
```

## Quick start

```ts
import { createClient } from '@blockchain0x/node';

const client = createClient({
  apiKey: process.env.B0X_API_KEY!, // sk_test_... or sk_live_...
});

// Read the agent's profile (any read_wallet_metadata or stronger scope).
const agent = await client.agents.get('agt_01HQX5...');

// Read 24h usage.
const usage = await client.apiKeys.usage({ windowDays: 1 });
console.log(`API calls today: ${usage.totals.calls}`);
```

The bound agent + workspace + network is determined by the API key. You never have to thread `agentId` or `workspaceId` through your calls - the server fence does it for you.

## Authentication + scopes

Two key shapes exist (see [docs/concept-api-key-types.md](https://github.com/Tosh-Labs/blockchain0x-app/blob/dev/docs/concept-api-key-types.md) for the full decision tree):

- **Wallet-only** (sub-plan 21.1): a key bound to ONE agent via `agentId`. The right shape for an autonomous AI agent that IS one wallet.
- **Workspace** (sub-plan 21.3): a key for human operators that can carry workspace-level scopes AND assignments to N specific wallets.

### Wallet scopes (four; identical in both shapes)

| Scope                    | What it grants                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `read_wallet_metadata`   | Read balances, transactions, earnings, audit log, spend permissions, payment requests, usage.               |
| `manage_wallet_metadata` | Superset of `read_wallet_metadata`. Adds: update public profile copy (tagline, social, about, SEO, avatar). |
| `pay_bills`              | Create payments (`client.payments.create(...)`). Capped by the agent's spend permission allowance.          |
| `receive_money`          | Create payment requests / invoices AND settle them on-chain (`paymentRequests.settle`).                     |

### Workspace scopes (two; workspace-flavor only)

| Scope                       | What it grants                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `read_workspace`            | Read workspace metadata, list members + agents, read audit log, read usage rollups.                     |
| `manage_workspace_metadata` | Superset of `read_workspace`. Adds: update workspace public copy (description, tagline, branding, SEO). |

Identity fields (name, slug, default network, disabled flag, owner) are dashboard-only forever - no scope can mutate them. API-key CRUD, webhook CRUD, team management, billing, and withdrawals are also dashboard-only.

A key without the required scope gets a typed `ApiKeyError` you can branch on (see below) - `apikey.scope_insufficient`, `apikey.workspace_scope_insufficient`, or `apikey.wallet_not_assigned`.

### Mint a wallet-only key

For autonomous agents that ARE one wallet. Today the SDK exposes the wallet-only flow:

```ts
const key = await client.apiKeys.create({
  label: 'Trading bot',
  agentId: 'agt_01HQXTRADING',
  scopes: ['read_wallet_metadata', 'pay_bills'],
});
console.log(key.secret); // shown ONCE - persist it in your secret store
```

### Mint a workspace key

For human operators that span many wallets. The body shape is mutually exclusive with the wallet-only shape - omit `agentId` and provide `workspaceScopes` and/or `walletAssignments`:

```ts
const key = await client.apiKeys.create({
  label: 'Treasury daily reconciliation',
  workspaceScopes: ['read_workspace'],
  walletAssignments: [
    { agentId: 'agt_trading', scopes: ['read_wallet_metadata'] },
    { agentId: 'agt_settlement', scopes: ['read_wallet_metadata'] },
  ],
  expiresInDays: 30, // optional; 7 / 30 / 60 / 90
});
console.log(key.secret); // shown ONCE
console.log(key.workspaceScopes); // ['read_workspace']
console.log(key.walletAssignments?.length); // 2
```

### RBAC-bounded creation

The server enforces: **the minter cannot grant a scope they do not have themselves**.

| Minter's workspace role  | Workspace scopes they can grant               | Per-wallet scopes they can grant                                      |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| Owner / Admin            | `read_workspace`, `manage_workspace_metadata` | All 4 wallet scopes on every wallet                                   |
| Developer (wallet-level) | `read_workspace`                              | All 4 wallet scopes on wallets the user has Developer+ grants on      |
| Viewer (wallet-level)    | `read_workspace`                              | `read_wallet_metadata` only on wallets the user has Viewer+ grants on |

Over-grant rejects with `apikey.role_insufficient_for_grants`. Ask a workspace Admin to mint the key with more scope.

### List + revoke

```ts
const page = await client.apiKeys.list({ workspaceId });
const workspaceKeys = page.data.filter((k) => k.agentId === null);
const walletOnly = page.data.filter((k) => k.agentId !== null);
console.log(workspaceKeys[0]?.walletAssignments?.length);

await client.apiKeys.revoke({ apiKeyId: 'ak_...' });
```

Cascade behaviour (workspace keys only): when an assigned wallet is soft-deleted, the assignment row is removed. If the key has zero workspace scopes AND no remaining wallet assignments, it auto-revokes with `apikey.no_grants_remaining`. Mint a fresh key.

## Webhooks: receive + verify

### Verify an inbound delivery

```ts
import express from 'express';
import { webhooks } from '@blockchain0x/node';

const app = express();
// IMPORTANT: capture the raw body, NOT the parsed JSON. The HMAC is
// computed over the exact bytes that arrived on the wire.
app.use(express.raw({ type: 'application/json' }));

app.post('/webhook', (req, res) => {
  const result = webhooks.verify({
    headers: req.headers,
    rawBody: req.body, // Buffer, raw bytes
    secret: process.env.B0X_WEBHOOK_SECRET!, // returned ONCE when you create/rotate the webhook
  });

  if (!result.ok) {
    // result.code is one of 7 dotted failure-mode codes (sub-plan 21.3
    // C-8 parity tightening; pre-0.3.0 codes were bare strings):
    //   webhook.secret_missing, webhook.signature_missing,
    //   webhook.signature_malformed, webhook.timestamp_missing,
    //   webhook.timestamp_invalid, webhook.timestamp_outside_window,
    //   webhook.signature_mismatch
    return res.status(400).json({ code: result.code });
  }

  // result.eventType, result.eventId, result.deliveryId are populated.
  const payload = JSON.parse(req.body.toString('utf8'));
  switch (result.eventType) {
    case 'payment.received':
      // ...
      break;
    case 'wallet.deployed':
      // ...
      break;
  }
  return res.status(200).end();
});
```

The verifier:

- Compares HMAC-SHA256 in constant time via `timingSafeEqual`.
- Rejects deliveries whose timestamp is more than 5 minutes from the verifier's clock (replay-window protection). Override with `toleranceSec` if your clock is known to skew.
- Accepts both the structured `t=<ts>,v1=<hex>` signature format AND a bare-hex signature (some load balancers strip the structured form; the timestamp comes from the dedicated `X-Blockchain0x-Timestamp` header in that case).

### Register + rotate webhook secrets

```ts
const wh = await client.webhooks.create({
  url: 'https://api.your-app.com/webhook',
  events: ['payment.received', 'wallet.deployed'],
});
console.log(wh.signingSecret); // STORE THIS - it is returned only once.

// Later, rotate it (immediate cutover, no overlap window):
const rotated = await client.webhooks.rotateSecret(wh.id);
console.log(rotated.signingSecret); // new secret
```

## Payments

```ts
const payment = await client.payments.create({
  toAddress: '0xabc...',
  amountUsdc: '12.50',
  note: 'invoice #42',
});
// payment.id is now persisted in your workspace and the chain submission
// is in flight. Subscribe to the `payment.sent` webhook for confirmation.
```

`payments.create` automatically attaches an `Idempotency-Key` header (a fresh hex UUID per call). If you pass one explicitly, it's used verbatim - so a single client-side retry collapses to a single on-chain submission. The default retry policy is OFF for payments to avoid silent double-spends; opt back in per call with `{ retry: 'default' }` when you've explicitly threaded your own idempotency key.

## Error handling

The SDK throws a discriminated union of typed errors:

```ts
import { Blockchain0xError, ApiKeyError, WebhookSignatureError } from '@blockchain0x/node';

try {
  await client.payments.create({ toAddress: '0xabc...', amountUsdc: '12.50' });
} catch (err) {
  if (err instanceof ApiKeyError) {
    // err.code is one of:
    //   apikey.invalid | apikey.expired | apikey.revoked
    //   apikey.network_mismatch | apikey.scope_insufficient
    //   apikey.agent_mismatch | apikey.agent_revoked
    //   apikey.unsupported_endpoint
    if (err.code === 'apikey.scope_insufficient') {
      // Mint a key with pay_bills
    }
  } else if (err instanceof Blockchain0xError) {
    // Any non-apikey error envelope from the API.
    console.error(err.code, err.requestId, err.status);
  } else {
    throw err; // network / SDK bug / unknown
  }
}
```

Every error carries `code`, `status`, `requestId`, and the original raw response body (when present) so you can include the request id in your own logs for support escalation.

## x402: monetize HTTP endpoints

The sibling package [`@blockchain0x/x402`](https://www.npmjs.com/package/@blockchain0x/x402) ships the wire primitives, client wrapper, and Fastify / Express adapters for the x402 payment-required protocol. Mint payment requests with this SDK (`client.paymentRequests.create`), then enforce them on your HTTP routes with the x402 server adapters:

```ts
import { createX402Plugin } from '@blockchain0x/x402/server/fastify';

await app.register(createX402Plugin, {
  client, // your @blockchain0x/node client
  resourceFor: (req) => `${req.method} ${req.routerPath}`,
});

app.post('/llm-query', { config: { x402: { amountWei: '100000' } } }, async (req) => {
  // req.x402 carries the verified payment for this call
  return { answer: 'Paid for via x402.' };
});
```

Client-side, `createX402Client` from `@blockchain0x/x402/client` wraps `fetch` to attach the `X-Payment` header automatically when a 402 challenge arrives. See the package README for the full surface.

## Network mode (testnet vs mainnet)

The key prefix encodes the network: `sk_test_...` keys talk to Base Sepolia; `sk_live_...` keys talk to Base mainnet. The SDK reads the network from the key and stamps `X-Network` on every request - mismatched callers (e.g. a test key with `network: 'mainnet'`) are rejected by the server with `apikey.network_mismatch`.

## Retries + timeouts

```ts
const client = createClient({
  apiKey: process.env.B0X_API_KEY!,
  timeoutMs: 30_000, // hard ceiling; the call aborts via AbortController
});
```

The default transport retries on `429` (honouring `Retry-After`) and `5xx`, with exponential backoff (250ms -> 500ms -> 1s, capped at 8s, 3 retries, 50% jitter). 4xx responses other than 429 do NOT retry. Opt out per call with `{ retry: 'off' }`; opt in for payments with `{ retry: 'default' }`.

## Roadmap

| Status    | Surface                                                                 |
| --------- | ----------------------------------------------------------------------- |
| Shipped   | `agents` resource (get + list + create)                                 |
| Shipped   | `apiKeys` resource (list + create + rotate + revoke + usage)            |
| Shipped   | `webhooks` resource (CRUD + rotate-secret + test-fire)                  |
| Shipped   | `payments.create` with auto Idempotency-Key                             |
| Shipped   | `webhooks.verify` HMAC verifier (5-minute replay window, constant-time) |
| In design | Browser ESM bundle (Edge + Cloudflare Workers compatible)               |
| In design | React hooks (`useAgents`, `useApiUsage`, ...)                           |
| In design | Python sibling: `pip install blockchain0x`                              |

## Reporting issues

- Bugs + feature requests: https://github.com/Tosh-Labs/blockchain0x-node/issues
- Security disclosures: see SECURITY.md in this repository.
- General docs: https://blockchain0x.com/docs

## License

[Apache-2.0](LICENSE) - Copyright (c) Blockchain0x.
