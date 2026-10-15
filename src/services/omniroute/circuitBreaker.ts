/**
 * Client-side circuit breaker for direct provider routing.
 *
 * Backs the six no-op functions in `adapter.ts` that used to defer all
 * cooldown/quota accounting to the OmniRoute gateway. With
 * `CCB_INTERNAL_ROUTER=1` there is no gateway to ask, so this module keeps
 * its own state:
 *
 *   - Sync in-process cache  →  isProviderFailure / isModelFailure /
 *                               isAccountFailure can be called synchronously
 *                               from the hot path in `openai/index.ts`.
 *   - Redis mirror          →  cross-process cooldown shared with the
 *                               existing `runtimeSignals` key layout
 *                               (cool:<provider>, cool:<provider>:<account>,
 *                                cool:<provider>:<model>).
 *   - PostgreSQL durable row→  survives CLI restart; one row per
 *                               (kind, provider, key) so rollback is a
 *                               single DELETE.
 *
 * Fail-closed only on explicit signal. Redis / PG outages do not block
 * traffic — the sync cache still protects this process, and writes are
 * fire-and-forget.
 */

import { pgQuery, pgExecute } from '../pg/pool.js'
import { redisSet, redisDel } from '../redis/client.js'

export type CircuitKind = 'provider' | 'model' | 'account'

export interface CircuitBreakerConfig {
  /** Default cooldown applied when `markProviderFailure` is called without an explicit value. */
  providerCooldownMs?: number
  /** Default cooldown applied when `markAccountFailure` is called without an explicit value. */
  accountCooldownMs?: number
  /** Default cooldown applied when `markModelFailure` is called without an explicit value. */
  modelCooldownMs?: number
  /** Quota below this % (0..100) trips an account-level breaker. */
  lowWatermark?: number
  /** How long to hold a slot wait when a provider is already cooling. */
  maxSlotWaitMs?: number
}

const DEFAULTS: Required<CircuitBreakerConfig> = {
  providerCooldownMs: 60_000,
  accountCooldownMs: 30_000,
  modelCooldownMs: 120_000,
  lowWatermark: 10,
  maxSlotWaitMs: 5_000,
}

let config: Required<CircuitBreakerConfig> = { ...DEFAULTS }

// ── In-process sync cache ───────────────────────────────────────────

interface CooldownEntry {
  until: number
  reason?: string
}

interface QuotaEntry {
  remaining: number
  recordedAt: number
}

const failures = new Map<string, CooldownEntry>()
const quotas = new Map<string, QuotaEntry>()
let seeded = false

function providerKey(providerId: string): string {
  return `provider:${providerId}`
}

function modelKey(providerId: string, model: string): string {
  return `model:${providerId}:${model}`
}

function accountKey(providerId: string, accountId: string): string {
  return `account:${providerId}:${accountId}`
}

function quotaKey(providerId: string, accountId: string): string {
  return `quota:${providerId}:${accountId}`
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function isFresh(entry: CooldownEntry | undefined): boolean {
  return entry != null && entry.until > nowSeconds()
}

// ── Sync public API ─────────────────────────────────────────────────

export function configureCircuitBreaker(next: CircuitBreakerConfig): void {
  config = { ...DEFAULTS, ...next }
}

export function resetCircuitBreakerForTests(): void {
  failures.clear()
  quotas.clear()
  seeded = false
  config = { ...DEFAULTS }
}

/**
 * Seed in-memory cache from PG so a fresh CLI process inherits any cooldowns
 * set by a previous one. Called lazily on first check.
 */
export async function ensureCircuitBreakerSeeded(): Promise<void> {
  if (seeded) return
  seeded = true
  for (const row of await readPgCooldowns()) {
    const existing = failures.get(row.key)
    if (row.until > nowSeconds() && (!existing || existing.until < row.until)) {
      failures.set(row.key, { until: row.until, reason: row.reason })
    }
  }
}

/** Whether a specific provider is currently in failure cooldown. */
export function isProviderFailure(providerId: string): boolean {
  return isFresh(failures.get(providerKey(providerId)))
}

/** Whether a specific (provider, model) pair is currently in failure cooldown. */
export function isModelFailure(providerId: string, model: string): boolean {
  return isFresh(failures.get(modelKey(providerId, model)))
}

/** Whether a specific (provider, account) pair is currently in failure cooldown. */
export function isAccountFailure(
  providerId: string,
  accountId: string,
): boolean {
  return isFresh(failures.get(accountKey(providerId, accountId)))
}

/** Register a provider-level failure with the default cooldown. */
export function markProviderFailure(
  providerId: string,
  cooldownMs?: number,
): void {
  const ms = cooldownMs ?? config.providerCooldownMs
  const until = nowSeconds() + Math.ceil(ms / 1000)
  failures.set(providerKey(providerId), { until, reason: 'provider_failure' })
  void mirrorToRedis('provider', providerId, undefined, until).catch(() => {})
  void mirrorToPg(
    'provider',
    providerId,
    undefined,
    until,
    'provider_failure',
  ).catch(() => {})
}

/** Register a (provider, model) failure. */
export function markModelFailure(
  providerId: string,
  model: string,
  cooldownMs?: number,
): void {
  const ms = cooldownMs ?? config.modelCooldownMs
  const until = nowSeconds() + Math.ceil(ms / 1000)
  failures.set(modelKey(providerId, model), { until, reason: 'model_failure' })
  void mirrorToRedis('model', providerId, model, until).catch(() => {})
  void mirrorToPg('model', providerId, model, until, 'model_failure').catch(
    () => {},
  )
}

/** Register an (provider, account) failure. */
export function markAccountFailure(
  providerId: string,
  accountId: string,
  cooldownMs?: number,
): void {
  const ms = cooldownMs ?? config.accountCooldownMs
  const until = nowSeconds() + Math.ceil(ms / 1000)
  failures.set(accountKey(providerId, accountId), {
    until,
    reason: 'account_failure',
  })
  void mirrorToRedis('account', providerId, accountId, until).catch(() => {})
  void mirrorToPg(
    'account',
    providerId,
    accountId,
    until,
    'account_failure',
  ).catch(() => {})
}

/** Clear a provider-level cooldown. */
export function clearProviderFailure(providerId: string): void {
  failures.delete(providerKey(providerId))
  void redisDel(`cool:${providerId}`).catch(() => {})
  void pgExecute(
    `DELETE FROM omniroute.ccb_circuit_state WHERE kind = 'provider' AND provider_id = $1`,
    [providerId],
  ).catch(() => {})
}

/** Clear a (provider, model) cooldown. */
export function clearModelFailure(providerId: string, model: string): void {
  failures.delete(modelKey(providerId, model))
  void redisDel(`cool:${providerId}:${model}`).catch(() => {})
  void pgExecute(
    `DELETE FROM omniroute.ccb_circuit_state WHERE kind = 'model' AND provider_id = $1 AND key = $2`,
    [providerId, model],
  ).catch(() => {})
}

/** Clear an (provider, account) cooldown. */
export function clearAccountFailure(
  providerId: string,
  accountId: string,
): void {
  failures.delete(accountKey(providerId, accountId))
  void redisDel(`cool:${providerId}:${accountId}`).catch(() => {})
  void pgExecute(
    `DELETE FROM omniroute.ccb_circuit_state WHERE kind = 'account' AND provider_id = $1 AND key = $2`,
    [providerId, accountId],
  ).catch(() => {})
}

/**
 * Record a quota refresh from a response header. When the remaining
 * percentage drops below the low-watermark threshold, an account-level
 * cooldown trips automatically so the next route selection skips it.
 */
export function updateAccountQuota(
  providerId: string,
  accountId: string,
  remaining: number,
): void {
  const clamped = Number.isFinite(remaining)
    ? Math.max(0, Math.min(100, remaining))
    : 0
  quotas.set(quotaKey(providerId, accountId), {
    remaining: clamped,
    recordedAt: nowSeconds(),
  })
  void redisSet(`quota:${providerId}:${accountId}`, String(clamped), 600).catch(
    () => {},
  )
  if (clamped < config.lowWatermark) {
    markAccountFailure(providerId, accountId, config.accountCooldownMs)
  }
}

/**
 * Rate-limit slot wait for outbound requests. If the provider is currently
 * cooling, waits up to `maxSlotWaitMs` before resolving — the caller decides
 * whether to bail. Otherwise resolves immediately.
 */
export async function waitForProviderRequestSlot(
  providerId: string,
  _accountId?: string,
): Promise<void> {
  const entry = failures.get(providerKey(providerId))
  if (!entry) return
  const remaining = entry.until - nowSeconds()
  if (remaining <= 0) {
    failures.delete(providerKey(providerId))
    return
  }
  const waitMs = Math.min(remaining * 1000, config.maxSlotWaitMs)
  if (waitMs <= 0) return
  await new Promise<void>(resolve => {
    setTimeout(resolve, waitMs)
  })
}

/** Snapshot of the current in-process state (for tests / observability). */
export function getCircuitBreakerSnapshot(): {
  failures: Record<string, CooldownEntry>
  quotas: Record<string, QuotaEntry>
  seeded: boolean
} {
  return {
    failures: Object.fromEntries(failures.entries()),
    quotas: Object.fromEntries(quotas.entries()),
    seeded,
  }
}

// ── Async Redis mirror ──────────────────────────────────────────────

async function mirrorToRedis(
  kind: CircuitKind,
  providerId: string,
  key: string | undefined,
  until: number,
): Promise<void> {
  const ttl = Math.max(1, until - nowSeconds())
  const redisKey =
    kind === 'provider'
      ? `cool:${providerId}`
      : `cool:${providerId}:${key ?? ''}`
  await redisSet(redisKey, String(until), ttl)
  if (kind === 'provider') {
    await redisSet(`health:${providerId}`, '0', ttl)
  }
}

// ── Async PG mirror ─────────────────────────────────────────────────

async function mirrorToPg(
  kind: CircuitKind,
  providerId: string,
  key: string | undefined,
  until: number,
  reason: string,
): Promise<void> {
  try {
    await pgExecute(
      `INSERT INTO omniroute.ccb_circuit_state (kind, provider_id, key, cooldown_until, reason, updated_at)
       VALUES ($1, $2, $3, to_timestamp($4), $5, to_timestamp($6))
       ON CONFLICT (kind, provider_id, key)
       DO UPDATE SET cooldown_until = GREATEST(ccb_circuit_state.cooldown_until, EXCLUDED.cooldown_until),
                     reason = EXCLUDED.reason,
                     updated_at = EXCLUDED.updated_at`,
      [kind, providerId, key ?? '__provider__', until, reason, nowSeconds()],
    )
  } catch {
    // Non-blocking by design — Redis + in-memory still enforce the cooldown.
  }
}

async function readPgCooldowns(): Promise<
  Array<{ key: string; until: number; reason?: string }>
> {
  try {
    const rows = await pgQuery<Record<string, unknown>>(
      `SELECT kind, provider_id, key, cooldown_until, reason
       FROM omniroute.ccb_circuit_state
       WHERE cooldown_until > now()`,
    )
    const out: Array<{ key: string; until: number; reason?: string }> = []
    for (const r of rows) {
      const kind = String(r.kind ?? '')
      const provider = String(r.provider_id ?? '')
      const key = r.key == null ? undefined : String(r.key)
      const untilTs = (
        r.cooldown_until as { getTime?: () => number }
      )?.getTime?.()
      const until = typeof untilTs === 'number' ? Math.floor(untilTs / 1000) : 0
      if (until <= 0) continue
      let localKey: string
      if (kind === 'provider') localKey = providerKey(provider)
      else if (kind === 'model') localKey = modelKey(provider, key ?? '')
      else if (kind === 'account') localKey = accountKey(provider, key ?? '')
      else continue
      out.push({
        key: localKey,
        until,
        reason: r.reason ? String(r.reason) : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

/** Idempotent schema bootstrap. Safe to re-run. */
export async function ensureCircuitBreakerSchema(): Promise<void> {
  try {
    await pgExecute(
      `CREATE TABLE IF NOT EXISTS omniroute.ccb_circuit_state (
         kind            TEXT        NOT NULL,
         provider_id     TEXT        NOT NULL,
         key             TEXT        NOT NULL DEFAULT '__provider__',
         cooldown_until  TIMESTAMPTZ NOT NULL,
         reason          TEXT        NULL,
         updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
         PRIMARY KEY (kind, provider_id, key)
       )`,
    )
  } catch {
    // Table already exists or PG unreachable — either is fine.
  }
}
