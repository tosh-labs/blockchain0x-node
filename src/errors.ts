/**
 * Structured error classes the SDK throws for failed responses.
 *
 * Sub-plan 21.1 row B-1 scaffold. Mirrors the backend's
 * `error-envelope` shape so SDK consumers can switch on the same
 * `code` slug they would see in the wire response.
 *
 * Customers do `instanceof Blockchain0xError` for the generic catch and
 * `instanceof WebhookSignatureError` / `instanceof ApiKeyError` for the
 * narrowed ones. Row B-2 wires the client to throw the appropriate
 * variant based on the response envelope; B-5 throws WebhookSignatureError
 * from `webhooks.verify(...)`.
 */

export interface Blockchain0xErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export class Blockchain0xError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = 'Blockchain0xError';
    this.code = args.code;
    this.status = args.status;
    this.requestId = args.requestId;
    this.details = args.details;
  }
}

/**
 * The closed set of `apikey.*` failure codes the backend emits.
 *
 * 13 codes total - sub-plan 21.3 row C-8 catalog. Branch on
 * `ApiKeyError.code` against this union for exhaustive handling:
 *
 *     try {
 *       await client.payments.create({ ... });
 *     } catch (err) {
 *       if (err instanceof ApiKeyError) {
 *         switch (err.code) {
 *           case 'apikey.scope_insufficient':
 *             // ... ask the operator to mint a wider key
 *             break;
 *           case 'apikey.wallet_not_assigned':
 *             // ... key has no grant on this wallet
 *             break;
 *           // ...
 *         }
 *       }
 *     }
 *
 * The constructor accepts any `string` so a forward-compat wire
 * (a 14th code added later) still throws ApiKeyError, just typed
 * as the broader code: branching code must include a default arm
 * or use `as` narrowing only when it is sure the wire is sealed.
 */
export type ApiKeyErrorCode =
  // Identity-bound (the key itself is invalid).
  | 'apikey.invalid'
  | 'apikey.revoked'
  | 'apikey.expired'
  // Agent-flavor binding errors (sub-plan 21.1).
  | 'apikey.agent_revoked'
  | 'apikey.agent_mismatch'
  // Surface-restriction errors.
  | 'apikey.workspace_endpoint_blocked'
  | 'apikey.unsupported_endpoint'
  // Network + scope.
  | 'apikey.network_mismatch'
  | 'apikey.scope_insufficient'
  // Workspace-flavor errors (sub-plan 21.3).
  | 'apikey.wallet_not_assigned'
  | 'apikey.workspace_scope_insufficient'
  | 'apikey.role_insufficient_for_grants'
  | 'apikey.no_grants_remaining';

export class ApiKeyError extends Blockchain0xError {
  constructor(args: {
    code: string;
    message: string;
    status: number;
    requestId?: string;
    details?: unknown;
  }) {
    super(args);
    this.name = 'ApiKeyError';
  }
}

/**
 * Webhook verifier failure-mode codes (sub-plan 21.3 row C-8 parity
 * tightening). Two changes vs the 0.2.0-alpha line:
 *
 *   1. Codes are now dotted (`webhook.*` prefix) - matches the
 *      Python/Go/Ruby/JVM SDKs and the openapi error-code catalog
 *      convention. Old consumers should migrate per
 *      packages/sdk-node/CHANGELOG.md.
 *   2. Two new failure modes split out from `timestamp_missing` and
 *      `signature_missing`:
 *        - `webhook.secret_missing`   - the caller passed `secret: ''`
 *        - `webhook.timestamp_invalid` - the timestamp parsed but
 *          was non-finite / non-positive (previously collapsed into
 *          `timestamp_missing`)
 */
export type WebhookSignatureErrorCode =
  | 'webhook.signature_missing'
  | 'webhook.signature_malformed'
  | 'webhook.timestamp_missing'
  | 'webhook.timestamp_invalid'
  | 'webhook.timestamp_outside_window'
  | 'webhook.signature_mismatch'
  | 'webhook.secret_missing';

export class WebhookSignatureError extends Error {
  /**
   * One of the verifier's known failure codes. Stable: customers
   * branch on this in their HTTP handler. See
   * [WebhookSignatureErrorCode] for the full union.
   */
  readonly code: WebhookSignatureErrorCode;

  constructor(code: WebhookSignatureErrorCode, message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.code = code;
  }
}
