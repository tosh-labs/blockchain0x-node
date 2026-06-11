# Changelog

All notable changes to `@blockchain0x/node` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-alpha.1] - 2026-06-11

Alpha iteration: resync the published SDK with the latest dev (sub-plan 27.1 security-hardening release). No breaking API changes.

## [0.3.0-alpha.0] - 2026-05-29

### Breaking

- `webhooks.verify` failure codes are now dotted (`webhook.*` prefix). Every code in the `WebhookSignatureErrorCode` union changed:

  - `signature_missing` → `webhook.signature_missing`
  - `signature_malformed` → `webhook.signature_malformed`
  - `timestamp_missing` → `webhook.timestamp_missing`
  - `timestamp_outside_window` → `webhook.timestamp_outside_window`
  - `signature_mismatch` → `webhook.signature_mismatch`

  Consumers branching on `result.code` need to add the `webhook.` prefix. The new format matches the openapi error-code convention and is now byte-equivalent across the Node, Python, Go, Ruby, and JVM SDKs (sub-plan 21.3 row C-8).

### Added

- Two new failure modes, split out for better diagnostics:
  - `webhook.secret_missing` - the caller passed `secret: ''` (previously collapsed into `signature_mismatch` via HMAC-of-empty-key).
  - `webhook.timestamp_invalid` - the `t=` value parsed but was non-finite / non-positive (previously collapsed into `timestamp_missing`).

## [0.2.0-alpha.3] - 2026-05-29

minor

## [0.2.0-alpha.2] - 2026-05-29

minor

## [0.2.0-alpha.1] - 2026-05-29

MInor update

## [0.1.0-alpha.2] - 2026-05-29

First release published from the public mirror repo
(`tosh-labs/blockchain0x-node`) via npm Trusted Publisher OIDC with
Sigstore **provenance attestation**. Functionally identical to
`0.1.0-alpha.1`; this version validates the two-stage release pipeline
(private monorepo -> mirror to public repo -> publish from public repo
with provenance).

### Changed

- `package.json` now declares `@types/node` in devDependencies so a
  standalone `npm install` outside the monorepo resolves cleanly. This
  was implicit (hoisted) in the monorepo build but explicit here for
  the public-repo build path.

## [0.1.0-alpha.1] - 2026-05-29

Published from the private monorepo via npm Trusted Publisher OIDC,
WITHOUT provenance attestation (npm requires the source repo to be
public for `--provenance` and `blockchain0x-app` is private).
Functionally identical to `0.1.0-alpha.0`; this version validated the
CI publish wire and ships the LICENSE + CHANGELOG files alongside the
tarball.

### Added

- `LICENSE` file (Apache-2.0) now ships in the tarball.
- `CHANGELOG.md` file shipping in the tarball.

## [0.1.0-alpha.0] - 2026-05-29

Initial alpha publish. Manual release via the committed
`scripts/publish.sh` helper.

### Added

- `createClient({ apiKey, baseUrl?, network?, timeoutMs? })` - the public
  entry point.
- `client.agents.get(id) / list() / create()` resource.
- `client.apiKeys.list() / create() / rotate(id) / revoke(id) / usage({ windowDays })`
  resource.
- `client.webhooks.list() / create() / update(id, patch) / delete(id) /
rotateSecret(id) / test(id, body)` resource.
- `client.payments.create(body, opts?)` with auto-minted `Idempotency-Key`
  and opt-in retry (`retry: 'default'`).
- `webhooks.verify({ headers, rawBody, secret, toleranceSec?, now? })` -
  HMAC-SHA256 verifier with constant-time comparison and a 5-minute replay
  window (matches the worker's signing scheme byte-for-byte).
- Discriminated-union error classes: `Blockchain0xError`, `ApiKeyError`,
  `WebhookSignatureError` with stable code strings (`apikey.scope_insufficient`,
  `apikey.agent_mismatch`, `signature_mismatch`, etc.).
- Auto-retry on `429` (honouring `Retry-After`) + `5xx` with exponential
  backoff (250ms / 500ms / 1s, capped at 8s, 3 retries, 50% jitter).
  `POST /v1/payments` is retry-off by default.

[0.3.0-alpha.1]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.3.0-alpha.1
[0.2.0-alpha.3]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.2.0-alpha.3
[0.2.0-alpha.2]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.2.0-alpha.2
[0.2.0-alpha.1]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.2.0-alpha.1
[0.1.0-alpha.2]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/tosh-labs/blockchain0x-node/releases/tag/v0.1.0-alpha.0
