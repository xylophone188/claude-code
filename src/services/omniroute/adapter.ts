/**
 * OmniRoute adapter — replaces the legacy ccbRouter runtime path.
 *
 * Direct-route resolution and account management go through the OmniRoute
 * OpenAI-compatible gateway. Configuration priority is OMNIRUTE_URL,
 * OMNIROUTE_BASE_URL, OPENAI_BASE_URL, then local OmniRoute on port 20131.
 */

import type { ProviderConfig } from '../providerRegistry/types.js'
import { loadProviders } from '../providerRegistry/loader.js'
import {
  clearCircuitFailure,
  isCircuitOpen,
  recordCircuitFailure,
  resetCircuitBreaker,
} from '../routing/circuitBreaker.js'

export interface DirectRoute {
  providerId: string
  baseURL: string
  model: string
  apiKey: string
  headers?: Record<string, string>
  timeoutMs?: number
  compatRule?: ProviderConfig['compatRule']
  accountId?: string
  kind: 'opencode' | 'provider' | 'race'
  race?: boolean
  tier?: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6'
  raceDelayMs?: number
  headroomMode?: 'token' | 'cache'
}

// ── Configuration ──────────────────────────────────────────────────

export interface OmniRouteConfig {
  baseUrl: string
  apiKey: string
  /** If true, OmniRoute handles race/auto routing server-side. */
  serverSideRouting: boolean
}

let cachedConfig: OmniRouteConfig | null | undefined

export function getOmniRouteConfig(): OmniRouteConfig | null {
  if (cachedConfig !== undefined) return cachedConfig
  const baseUrl =
    process.env.OMNIRUTE_URL ??
    process.env.OMNIROUTE_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    'http://127.0.0.1:20131/v1'
  const apiKey =
    process.env.OMNIRUTE_API_KEY ?? process.env.OMNIROUTE_API_KEY ?? ''
  cachedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    serverSideRouting: process.env.OMNIROUTE_SERVER_ROUTING !== '0',
  }
  return cachedConfig
}

/** Reset cached config (for tests). */
export function resetOmniRouteConfig(): void {
  cachedConfig = undefined
}

// ── Route Resolution ───────────────────────────────────────────────

/**
 * Resolve direct routes for a model spec. When OmniRoute is configured,
 * delegates routing to the OmniRoute gateway.
 */
export function resolveDirectRoutes(
  spec: string,
  prompt?: string,
): DirectRoute[] {
  const raw = spec.trim()
  if (!raw) return []
  if (process.env.CCB_INTERNAL_ROUTER === '1') {
    return resolveViaInternalRouter(raw)
  }
  const config = getOmniRouteConfig()
  if (!config) return []
  // Preserve native ChatGPT/Codex and Anthropic paths for bare model names and
  // virtual advisor aliases. OmniRoute owns explicit CCB/auto/race/provider
  // routes only; otherwise it would silently bypass OAuth Responses routing.
  const isGatewayRoute =
    /^(?:ccb\/|auto(?:\/|$)|race(?:\/|$)|.*-pool$)/i.test(raw) ||
    (raw.includes('/') &&
      !/^(?:advisor|lite|full|ultra|review|smart|opus)$/i.test(raw))
  if (!isGatewayRoute) return []
  return resolveViaOmniRoute(spec, prompt, config)
}

const INTERNAL_POOL_ORDER = {
  v8: ['sensenova', 'nvidia', 'opencode'],
  auto: ['sensenova', 'nvidia', 'opencode'],
  'worker-pool': ['nvidia', 'opencode', 'sensenova'],
  'chat-pool': ['sensenova', 'qwen', 'glm', 'nvidia'],
  'advisor-pool': ['sensenova', 'deepseek', 'nvidia', 'codex'],
  'review-pool': ['sensenova', 'deepseek', 'nvidia', 'codex'],
} as const

function normalizeDirectBaseUrl(baseUrl: string): string {
  return baseUrl
    .replace(/\/(?:chat\/completions|responses)\/?$/, '')
    .replace(/\/+$/, '')
}

function providerKeys(
  provider: ProviderConfig,
): Array<{ id?: string; apiKey: string; model?: string }> {
  const accounts = (provider.accounts ?? [])
    .filter(account => account.enabled !== false)
    .flatMap(account => {
      const apiKey =
        account.apiKey ??
        (account.apiKeyEnv ? process.env[account.apiKeyEnv] : undefined)
      return apiKey ? [{ id: account.id, apiKey, model: account.model }] : []
    })
  if (accounts.length) return accounts
  const apiKey =
    provider.apiKey ??
    (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
  return apiKey ? [{ apiKey }] : provider.noAuth ? [{ apiKey: '' }] : []
}

function resolveViaInternalRouter(spec: string): DirectRoute[] {
  const trimmed = spec.replace(/^ccb\//i, '')
  const poolName = trimmed.toLowerCase() as keyof typeof INTERNAL_POOL_ORDER
  const providers = loadProviders().filter(
    provider => provider.kind === 'openai-compat',
  )
  const requestedProvider = trimmed.includes('/')
    ? trimmed.slice(0, trimmed.indexOf('/'))
    : trimmed
  const requestedModel = trimmed.includes('/')
    ? trimmed.slice(trimmed.indexOf('/') + 1)
    : undefined
  const ordered = INTERNAL_POOL_ORDER[poolName]
  const selected = ordered
    ? [...providers].sort(
        (a, b) =>
          (ordered.indexOf(a.id as never) + 1 || 99) -
          (ordered.indexOf(b.id as never) + 1 || 99),
      )
    : providers.filter(provider => provider.id === requestedProvider)
  const routes: DirectRoute[] = []
  for (const provider of selected) {
    const keys = providerKeys(provider)
    const models = requestedModel
      ? [requestedModel]
      : [
          ...new Set(
            (provider.accounts ?? [])
              .map(account => account.model)
              .filter(Boolean)
              .concat(provider.models ?? [], provider.defaultModel),
          ),
        ]
    for (const key of keys) {
      for (const model of models) {
        if (!model) continue
        const effectiveModel =
          provider.id === 'nvidia' && !model.includes('/')
            ? 'nvidia/' + model
            : model
        routes.push({
          providerId: provider.id,
          baseURL: normalizeDirectBaseUrl(provider.baseUrl),
          model: effectiveModel,
          apiKey: key.apiKey,
          headers: provider.headers,
          timeoutMs: provider.timeoutMs,
          compatRule: provider.compatRule,
          accountId: key.id,
          kind: 'provider',
        })
      }
    }
  }
  return routes
}

export function isInternalRouterEnabled(): boolean {
  return process.env.CCB_INTERNAL_ROUTER === '1'
}

export function resetOmniRouteConfigForTests(): void {
  resetOmniRouteConfig()
}

export function resetDirectRouteStateForTests(): void {
  resetOmniRouteConfig()
}

function resolveViaOmniRoute(
  spec: string,
  _prompt: string | undefined,
  config: OmniRouteConfig,
): DirectRoute[] {
  // OmniRoute acts as an OpenAI-compatible gateway: it accepts any
  // provider/model spec and routes to the appropriate upstream.
  const trimmed = spec.trim()
  if (!trimmed) return []
  const stripped = trimmed.replace(/^ccb\//i, '')
  const modelSpec = /^(?:auto|race)$/i.test(stripped) ? 'auto/smart' : stripped
  if (/^(?:auto|race)(?:\/|$)/i.test(modelSpec)) {
    if (config.serverSideRouting) {
      return [
        {
          providerId: 'omniroute',
          baseURL: config.baseUrl,
          model: modelSpec,
          apiKey: config.apiKey,
          kind: 'provider',
        },
      ]
    }
    return [
      {
        providerId: 'omniroute',
        baseURL: config.baseUrl,
        model: modelSpec,
        apiKey: config.apiKey,
        kind: 'provider',
      },
    ]
  }
  return [
    {
      providerId: 'omniroute',
      baseURL: config.baseUrl,
      model: modelSpec,
      apiKey: config.apiKey,
      kind: 'provider',
    },
  ]
}

// ── Provider Model Listing ─────────────────────────────────────────

/**
 * List available provider models. When OmniRoute is configured,
 * queries the OmniRoute gateway; otherwise returns empty.
 */
export function listDirectProviderModels(): Array<{
  providerId: string
  models: string[]
}> {
  const config = getOmniRouteConfig()
  if (!config) return []
  // OmniRoute is a single gateway — report it as a single provider
  return [{ providerId: 'omniroute', models: ['auto'] }]
}

// ── Account Pool ───────────────────────────────────────────────────

/**
 * Choose accounts for a provider. When OmniRoute is configured,
 * the gateway manages accounts server-side; return a single
 * synthetic account so callers don't skip the provider.
 */
export function chooseAccounts(
  provider: ProviderConfig,
): Array<{ id: string; apiKey: string; model?: string }> {
  const config = getOmniRouteConfig()
  if (!config) return []
  return [
    {
      id: 'omniroute-default',
      apiKey: config.apiKey,
      model: provider.defaultModel,
    },
  ]
}

/**
 * Wait for a provider request slot. OmniRoute handles rate limiting
 * server-side, so this is a no-op.
 */
export async function waitForProviderRequestSlot(
  _providerId: string,
  _accountId?: string,
): Promise<void> {
  // OmniRoute gateway manages rate limiting server-side.
}

// ── Failure Tracking ───────────────────────────────────────────────

/** Mark an account as failed. No-op when OmniRoute manages accounts. */
export function markAccountFailure(
  _providerId: string,
  _accountId: string,
  _cooldownMs?: number,
): void {}

/** Clear an account failure. No-op when OmniRoute manages accounts. */
export function clearAccountFailure(
  _providerId: string,
  _accountId: string,
): void {}

/** Mark a provider as failed. No-op when OmniRoute manages routing. */
export function markProviderFailure(
  _providerId: string,
  _cooldownMs?: number,
): void {}

/** Check if a provider is in failure cooldown. Always false with OmniRoute. */
export function isProviderFailure(_providerId: string): boolean {
  return false
}

/** Mark a model as failed. No-op when OmniRoute manages routing. */
export function markModelFailure(
  _providerId: string,
  _model: string,
  _cooldownMs?: number,
): void {}

/** Clear a model failure. No-op when OmniRoute manages routing. */
export function clearModelFailure(_providerId: string, _model: string): void {}

/** Check if a model is in failure cooldown. Always false with OmniRoute. */
export function isModelFailure(_providerId: string, _model: string): boolean {
  return false
}

/** Update account quota from response headers. */
export function updateAccountQuota(
  _providerId: string,
  _accountId: string,
  _remaining: number,
): void {}

// ── Race Metrics ───────────────────────────────────────────────────

export type RaceErrorCategory =
  | 'rate_limit'
  | 'transient'
  | 'permanent'
  | 'auth'
  | 'timeout'
  | 'unknown'

export function classifyErrorStatus(
  status: number | undefined,
  aborted = false,
): RaceErrorCategory {
  if (aborted) return 'transient'
  if (status === undefined) return 'unknown'
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 503 || status === 502 || status === 504) return 'transient'
  if (status === 404 || status === 400) return 'permanent'
  return 'unknown'
}

export interface ActiveCcbRoute {
  provider: string
  model: string
}

export interface OmniRouteReceipt {
  requestId?: string
  provider?: string
  model?: string
  latencyMs?: number
  fallbackAttempts?: number
  compression?: string
  decision?: string
}

let lastOmniRouteReceipt: OmniRouteReceipt | null = null

export function parseOmniRouteReceipt(
  headers: Headers,
): OmniRouteReceipt | null {
  const value = (name: string) => headers.get(name) ?? undefined
  const number = (name: string) => {
    const n = Number(value(name))
    return Number.isFinite(n) ? n : undefined
  }
  const receipt: OmniRouteReceipt = {
    requestId: value('x-omniroute-request-id'),
    provider: value('x-omniroute-provider'),
    model: value('x-omniroute-model'),
    latencyMs: number('x-omniroute-latency-ms'),
    fallbackAttempts: number('x-omniroute-fallback-attempts'),
    compression: value('x-omniroute-compression'),
    decision: value('x-omniroute-decision'),
  }
  if (!Object.values(receipt).some(v => v !== undefined)) return null
  lastOmniRouteReceipt = receipt
  return receipt
}

export function getLastOmniRouteReceipt(): OmniRouteReceipt | null {
  return lastOmniRouteReceipt
}

let activeCcbRoute: ActiveCcbRoute | null = null

export function setActiveCcbRoute(provider: string, model: string): void {
  activeCcbRoute = { provider, model }
}

export function getActiveCcbRoute(): ActiveCcbRoute | null {
  return activeCcbRoute
}

export function getRaceMetricPreferences(): ReadonlyMap<string, number> {
  // Server-side routing owns learning/ranking. Keep this compatibility shim
  // neutral; CCB must not resurrect a second local policy engine.
  return new Map()
}

export function recordRaceMetric(_metric: Record<string, unknown>): void {
  // Request outcome is already observed by OmniRoute from the gateway stream.
  // Deliberately no-op: no duplicate local JSONL ledger or client-side policy.
}

export function readFileTail(_path: string, _maxBytes?: number): string {
  return ''
}

// ── Error Classification ───────────────────────────────────────────

export type FailoverReason =
  | 'rate_limit'
  | 'quota_exceeded'
  | 'auth_invalid'
  | 'billing'
  | 'server_error'
  | 'timeout'
  | 'model_output'
  | 'network'
  | 'unknown'

export interface ErrorClassification {
  reason: FailoverReason
  status?: number
  retryable: boolean
  scope: 'provider' | 'model' | 'account'
}

export function classifyError(error: unknown): ErrorClassification {
  const status = (error as { status?: number } | undefined)?.status
  const message = String(
    (error as { message?: string } | undefined)?.message ?? '',
  ).toLowerCase()
  const name = (error as { name?: string } | undefined)?.name ?? ''

  if (/provideroutputerror|invalid provider text|empty stream/i.test(name))
    return { reason: 'model_output', retryable: false, scope: 'model' }
  if (status === 401 || status === 403)
    return {
      reason: 'auth_invalid',
      status,
      retryable: false,
      scope: 'account',
    }
  if (status === 402 || /quota|balance|insufficient/.test(message))
    return {
      reason: 'quota_exceeded',
      status,
      retryable: false,
      scope: 'account',
    }
  if (status === 429 || /rate.?limit/i.test(message))
    return { reason: 'rate_limit', status, retryable: true, scope: 'account' }
  if (status && status >= 500)
    return {
      reason: 'server_error',
      status,
      retryable: true,
      scope: 'provider',
    }
  if (status && status >= 400)
    return { reason: 'model_output', status, retryable: false, scope: 'model' }
  if (/abort|timeout|timed.?out|deadline|eof|socket/.test(message))
    return { reason: 'timeout', retryable: true, scope: 'provider' }
  if (/econnrefused|enetunreach|eai_again|socket hang up/i.test(message))
    return { reason: 'network', retryable: true, scope: 'provider' }
  return { reason: 'unknown', retryable: true, scope: 'provider' }
}

export function isRetryable(error: unknown): boolean {
  return [
    'rate_limit',
    'server_error',
    'timeout',
    'network',
    'unknown',
  ].includes(classifyError(error).reason)
}

export function isPermanentError(error: unknown): boolean {
  return ['auth_invalid', 'billing', 'model_output', 'quota_exceeded'].includes(
    classifyError(error).reason,
  )
}
