/**
 * circuitBreaker.ts — provider/model/account availability breaker for routed
 * requests.
 *
 * The gate is intentionally lifecycle-based rather than score-based. A healthy
 * provider with a low score may still be selected; a broken one must not. State
 * lives only in module maps and callers decide persistence boundaries.
 */
import { routeLog } from './stageLog.js'

export type CircuitScope = 'provider' | 'model' | 'account'
export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerConfig {
  /** Consecutive failures before opening. Default 3. */
  failureThreshold?: number
  /** Half-open wait time. Default 60 seconds. */
  cooldownMs?: number
  /** Successful attempts required in half-open. Default 1. */
  successThreshold?: number
}

export interface CircuitBreakerDecision {
  scope: CircuitScope
  key: string
  state: CircuitState
  allowed: boolean
  remainingFailures: number
  remainingSuccesses: number
  retryAfterMs: number
}

export interface CircuitBreakerSnapshot {
  entries: Record<string, CircuitBreakerDecision>
}

export type CircuitEvent = {
  scope: CircuitScope
  provider: string
  model?: string
  accountId?: string
  attempt?: number
  detail?: string
}

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 60 * 1000
const DEFAULT_SUCCESS_THRESHOLD = 1

type CircuitEntry = {
  state: CircuitState
  failures: number
  successes: number
  opensAt: number
}

const entries = new Map<string, CircuitEntry>()

export function circuitScopeKey(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
): string {
  switch (scope) {
    case 'provider':
      return `provider:${provider}`
    case 'model':
      return `model:${provider}/${model ?? ''}`
    case 'account':
      return `account:${provider}/${accountId ?? 'default'}`
  }
}

export function isCircuitOpen(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
  config: CircuitBreakerConfig = {},
  now = Date.now(),
): boolean {
  return (
    getCircuitState(scope, provider, model, accountId, config, now).allowed ===
    false
  )
}

export function getCircuitState(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
  config: CircuitBreakerConfig = {},
  now = Date.now(),
): CircuitBreakerDecision {
  const cfg = normalizeConfig(config)
  const key = circuitScopeKey(scope, provider, model, accountId)
  const entry = entries.get(key)
  if (!entry) {
    return emptyDecision(scope, key, cfg)
  }

  if (entry.state === 'open' && now >= entry.opensAt) {
    entry.state = 'half-open'
    entry.successes = 0
  }

  if (entry.state === 'open') {
    return {
      scope,
      key,
      state: entry.state,
      allowed: false,
      remainingFailures: 0,
      remainingSuccesses: cfg.successThreshold,
      retryAfterMs: entry.opensAt - now,
    }
  }

  if (entry.state === 'half-open') {
    return {
      scope,
      key,
      state: entry.state,
      allowed: true,
      remainingFailures: 1,
      remainingSuccesses: cfg.successThreshold - entry.successes,
      retryAfterMs: 0,
    }
  }

  return {
    scope,
    key,
    state: entry.state,
    allowed: true,
    remainingFailures: Math.max(0, cfg.failureThreshold - entry.failures),
    remainingSuccesses: 0,
    retryAfterMs: 0,
  }
}

export function recordCircuitFailure(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
  config: CircuitBreakerConfig = {},
  now = Date.now(),
): CircuitBreakerDecision {
  const cfg = normalizeConfig(config)
  const key = circuitScopeKey(scope, provider, model, accountId)
  const entry = entries.get(key) ?? {
    state: 'closed',
    failures: 0,
    successes: 0,
    opensAt: 0,
  }

  entry.failures += 1
  entry.successes = 0
  if (
    (entry.state === 'closed' && entry.failures >= cfg.failureThreshold) ||
    entry.state === 'half-open'
  ) {
    entry.state = 'open'
    entry.opensAt = now + cfg.cooldownMs
    routeLog('breaker', `circuit ${key} opened for ${cfg.cooldownMs}ms`)
  }
  entries.set(key, entry)
  return getCircuitState(scope, provider, model, accountId, cfg, now)
}

export function recordCircuitSuccess(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
  config: CircuitBreakerConfig = {},
  now = Date.now(),
): CircuitBreakerDecision {
  const cfg = normalizeConfig(config)
  const key = circuitScopeKey(scope, provider, model, accountId)
  getCircuitState(scope, provider, model, accountId, cfg, now)
  const entry = entries.get(key)
  if (!entry) return emptyDecision(scope, key, cfg)

  entry.failures = 0
  if (entry.state === 'half-open') {
    entry.successes += 1
    if (entry.successes >= cfg.successThreshold) {
      entry.state = 'closed'
      entry.opensAt = 0
      routeLog('breaker', `circuit ${key} closed`)
    }
  } else if (entry.state === 'closed') {
    entry.successes = 0
  }
  entries.set(key, entry)
  return getCircuitState(scope, provider, model, accountId, cfg, now)
}

export function clearCircuitFailure(
  scope: CircuitScope,
  provider: string,
  model?: string,
  accountId?: string,
  config: CircuitBreakerConfig = {},
  now = Date.now(),
): void {
  recordCircuitSuccess(scope, provider, model, accountId, config, now)
}

export function resetCircuitBreaker(): void {
  entries.clear()
}

export function snapshotCircuitBreaker(): CircuitBreakerSnapshot {
  const out: Record<string, CircuitBreakerDecision> = {}
  for (const key of entries.keys()) {
    const [scope, rest] = key.split(':') as [CircuitScope, string]
    const [provider, suffix] = rest.split('/', 2)
    out[key] = getCircuitState(
      scope,
      provider,
      scope === 'model' ? suffix : undefined,
      scope === 'account' ? suffix || 'default' : undefined,
    )
  }
  return { entries: out }
}

function emptyDecision(
  scope: CircuitScope,
  key: string,
  cfg: CircuitBreakerConfig,
): CircuitBreakerDecision {
  const normalized = normalizeConfig(cfg)
  return {
    scope,
    key,
    state: 'closed',
    allowed: true,
    remainingFailures: normalized.failureThreshold,
    remainingSuccesses: 0,
    retryAfterMs: 0,
  }
}

function normalizeConfig(
  config: CircuitBreakerConfig,
): Required<CircuitBreakerConfig> {
  return {
    failureThreshold: DEFAULT_FAILURE_THRESHOLD,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    successThreshold: DEFAULT_SUCCESS_THRESHOLD,
    ...config,
  }
}
