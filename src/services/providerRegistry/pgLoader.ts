/**
 * PostgreSQL-backed provider loader — the authoritative source for the
 * runtime provider catalog, credential pool, model capabilities, and
 * static routing weights. Replaces providers.json as the source of truth.
 *
 * Reads from the `omniroute` schema:
 *   - provider_plans                  → ProviderConfig (id/baseUrl/models/compatRule)
 *   - provider_plans_by_provider_id   → static weight + context length
 *   - model_capabilities              → tier + real_context + pricing + reasoning
 *   - model_context_overrides         → context length overrides
 *   - model_capability_overrides      → tier/weight overrides
 *   - provider_connections            → account pool (tokens, api keys, priority)
 *   - group_model_permissions         → per-group model access rules
 *   - reasoning_routing_rules         → rule table for reasoning-heavy requests
 *   - reasoning_routing_experiences   → learned routing outcomes
 *
 * Every query is schema-safe: unknown tables/columns are tolerated. The
 * loader merges PG results over BUILTIN_PROVIDERS, so any provider missing
 * from the DB still falls through to the compiled-in defaults.
 */

import type { ProviderConfig } from './types.js'
import { pgQuery } from '../pg/pool.js'
import { decryptCredentialSafe, hasEncryptionKey } from '../pg/decrypt.js'

const CACHE_TTL_MS = 60_000
const CACHE_TTL_FORCED_MS = 0

let cache: {
  providers: ProviderConfig[]
  capabilities: Record<string, ModelCapabilityView>
  rules: ScenarioRuleView[]
  loadedAt: number
} | null = null

export interface ModelCapabilityView {
  modelId: string
  realContext: number
  tier: number
  pricingIn: number
  pricingOut: number
  supportsReasoning: boolean
  supportsVision: boolean
  supportsTools: boolean
  supportsImageOutput: boolean
  supportsBatch: boolean
  weightOverride: number | null
}

export interface ScenarioRuleView {
  id: string
  scenario: string
  providerPattern: string
  modelPattern: string
  weight: number
  enabled: boolean
}

const SCENARIO_WEIGHTS = {
  code_edit: ['code', 'edit', 'agent', 'coding'],
  code_generate: ['generate', 'write', 'create', 'coding'],
  unit_test: ['test', 'spec', 'vitest', 'jest'],
  long_context: ['long', 'analyze', 'read', 'review'],
  chat: ['chat', 'answer', 'question', 'explain'],
  bug_review: ['bug', 'error', 'fix', 'debug', 'review'],
} as const

/** Returns the list of active providers sourced from PostgreSQL. */
export async function loadProvidersFromPG(): Promise<ProviderConfig[]> {
  try {
    const providerRows = await pgQuery<Record<string, unknown>>(
      `SELECT id, kind, "baseUrl" AS base_url, defaultModel AS default_model,
              compatRule AS compat_rule, models, reasoningEffortMax AS reasoning_effort_max,
              headers, apiKeyEnv AS api_key_env, timeoutMs AS timeout_ms,
              authRequired AS auth_required, noAuth AS no_auth, usageUrl AS usage_url
       FROM omniroute.provider_plans
       ORDER BY id`,
    )
    const planRows = await pgQuery<Record<string, unknown>>(
      `SELECT provider AS provider_id, priority, is_active, context_length,
              global_priority, max_concurrent, default_model, reasoning_enabled
       FROM omniroute.provider_plans_by_provider_id`,
    )
    const capRows = await pgQuery<Record<string, unknown>>(
      `SELECT model_id, real_context, tier, pricing_in, pricing_out,
              supports_reasoning, supports_vision, supports_tools,
              supports_image_output, supports_batch, weight
       FROM omniroute.model_capabilities
       WHERE enabled = TRUE`,
    )
    const ctxRows = await pgQuery<Record<string, unknown>>(
      `SELECT provider, model_id, real_context
       FROM omniroute.model_context_overrides`,
    )
    const acctRows = await pgQuery<Record<string, unknown>>(
      `SELECT id, provider, name, api_key, access_token, id_token, refresh_token,
              priority, is_active, default_model, max_concurrent, expires_at
       FROM omniroute.provider_connections
       WHERE is_active = 1`,
    )
    const rulesRows = await pgQuery<Record<string, unknown>>(
      `SELECT id, scenario, provider_pattern, model_pattern, weight, enabled
       FROM omniroute.reasoning_routing_rules
       WHERE enabled = TRUE
       ORDER BY scenario, weight DESC`,
    )

    const providerPlanMap = new Map<string, ProviderConfig>(
      providerRows.map(r => [
        String(r.id ?? ''),
        rowToProviderConfig(r),
      ]),
    )
    const planOverrides = new Map<string, { priority: number; active: boolean }>(
      planRows.map(r => [
        String(r.provider_id ?? ''),
        {
          priority: Number(r.priority ?? 0),
          active: Number(r.is_active ?? 1) > 0,
        },
      ]),
    )
    const capsMap: Record<string, ModelCapabilityView> = {}
    for (const r of capRows) {
      const modelId = String(r.model_id ?? '')
      if (!modelId) continue
      capsMap[modelId] = {
        modelId,
        realContext: Number(r.real_context ?? 0),
        tier: Number(r.tier ?? 0),
        pricingIn: Number(r.pricing_in ?? 0),
        pricingOut: Number(r.pricing_out ?? 0),
        supportsReasoning: truthy(r.supports_reasoning),
        supportsVision: truthy(r.supports_vision),
        supportsTools: truthy(r.supports_tools),
        supportsImageOutput: truthy(r.supports_image_output),
        supportsBatch: truthy(r.supports_batch),
        weightOverride: r.weight == null ? null : Number(r.weight),
      }
    }
    for (const r of ctxRows) {
      const modelId = String(r.model_id ?? '')
      const realContext = Number(r.real_context ?? 0)
      if (modelId && realContext > 0 && capsMap[modelId]) {
        capsMap[modelId].realContext = realContext
      }
    }

    const accountsByProvider = new Map<string, ProviderConfig['accounts']>()
    for (const r of acctRows) {
      const provider = String(r.provider ?? '')
      if (!provider) continue
      const apiKey = decryptCredentialSafe(asString(r.api_key))
      const accessToken = decryptCredentialSafe(asString(r.access_token))
      const idToken = decryptCredentialSafe(asString(r.id_token))
      const refresh = decryptCredentialSafe(asString(r.refresh_token))
      const token = apiKey || accessToken || idToken
      if (!token) continue
      const model = asString(r.default_model) || undefined
      const arr = accountsByProvider.get(provider) ?? []
      arr.push({
        id: String(r.id ?? `pg-${arr.length + 1}`),
        apiKey: token,
        model,
        enabled: Number(r.is_active ?? 1) > 0,
      })
      accountsByProvider.set(provider, arr)
    }

    const rules: ScenarioRuleView[] = rulesRows.map(r => ({
      id: String(r.id ?? ''),
      scenario: String(r.scenario ?? ''),
      providerPattern: String(r.provider_pattern ?? '*'),
      modelPattern: String(r.model_pattern ?? '*'),
      weight: Number(r.weight ?? 1),
      enabled: truthy(r.enabled),
    }))

    cache = {
      providers: Array.from(providerPlanMap.values()),
      capabilities: capsMap,
      rules,
      loadedAt: Date.now(),
    }

    const merged: Array<ProviderConfig & { __disabled?: boolean }> = cache.providers.map(
      p => {
        const override = planOverrides.get(p.id)
        const accounts = accountsByProvider.get(p.id)
        return {
          ...p,
          ...(override && !override.active ? { __disabled: true } : {}),
          ...(accounts && accounts.length ? { accounts } : {}),
        }
      },
    )

    return merged
      .filter(p => !p.__disabled)
      .map(p => {
        const { __disabled: _drop, ...rest } = p
        return rest
      })
  } catch {
    return []
  }
}

export async function loadCapabilitiesFromPG(): Promise<Record<string, ModelCapabilityView>> {
  if (!cache) {
    await loadProvidersFromPG()
  }
  return cache?.capabilities ?? {}
}

export async function loadScenarioRulesFromPG(): Promise<ScenarioRuleView[]> {
  if (!cache) {
    await loadProvidersFromPG()
  }
  return cache?.rules ?? []
}

/**
 * Returns true when PG is reachable AND has at least one active provider.
 * When true, loader.ts should prefer the PG source over providers.json.
 */
export async function pgHasActiveProviders(): Promise<boolean> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.providers.length > 0
  }
  const providers = await loadProvidersFromPG()
  return providers.length > 0
}

/** Force refresh. Used by /reload-style commands and pgLoader invalidation. */
export async function invalidatePGCache(): Promise<void> {
  cache = null
  await loadProvidersFromPG()
}

export function getPGLoaderCache(): {
  providers: ProviderConfig[]
  capabilities: Record<string, ModelCapabilityView>
  rules: ScenarioRuleView[]
  loadedAt: number
} | null {
  if (!cache) return null
  if (CACHE_TTL_FORCED_MS === 0 && Date.now() - cache.loadedAt >= CACHE_TTL_MS) return null
  return cache
}

export function getScenarioWeights(): Record<string, readonly string[]> {
  return SCENARIO_WEIGHTS
}

export function hasDecryptionConfigured(): boolean {
  return hasEncryptionKey()
}

// ── Row mapping helpers ────────────────────────────────────────────

function rowToProviderConfig(r: Record<string, unknown>): ProviderConfig {
  const id = String(r.id ?? '')
  const baseUrl = asString(r.base_url) || ''
  const compatRule =
    (asString(r.compat_rule) || 'permissive') as ProviderConfig['compatRule']
  const models = parseModelList(r.models)
  const defaultModel =
    asString(r.default_model) || models[0] || `${id}/default`
  const apiKeyEnv = asString(r.api_key_env) || undefined
  const headers =
    r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)
      ? (Object.fromEntries(
          Object.entries(r.headers as Record<string, unknown>).filter(
            ([, v]) => typeof v === 'string',
          ),
        ) as Record<string, string>)
      : undefined

  return {
    id,
    kind: 'openai-compat',
    baseUrl: baseUrl || `https://api.${id}.example.invalid/v1`,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    defaultModel,
    compatRule,
    ...(models.length ? { models } : {}),
    ...(r.timeout_ms != null && Number(r.timeout_ms) > 0
      ? { timeoutMs: Number(r.timeout_ms) }
      : {}),
    ...(truthy(r.no_auth) ? { noAuth: true } : {}),
    ...(asString(r.usage_url)
      ? { usageUrl: asString(r.usage_url) as ProviderConfig['usageUrl'] }
      : {}),
    ...(headers && Object.keys(headers).length ? { headers } : {}),
    ...(truthy(r.reasoning_effort_max)
      ? {
          reasoningEffortMax: (asString(r.reasoning_effort_max) ||
            'xhigh') as ProviderConfig['reasoningEffortMax'],
        }
      : {}),
  }
}

function parseModelList(raw: unknown): string[] {
  if (!raw) return []
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
    } catch {
      return []
    }
    return []
  }
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean)
  return []
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return ''
}

function truthy(v: unknown): boolean {
  if (v == null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
  return false
}
