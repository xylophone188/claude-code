/**
 * OpenCode 429 fallback chain: Clash public nodes → VPS dedicated exit → NVIDIA NIM.
 *
 * The Clash rotator (clashNodeRotator.ts) owns node-level rotation and cooling.
 * When every public node is cooled it reports `rotated: false`, and the request
 * loop must leave the opencode route rather than burn its remaining retries.
 * This module owns the routes it falls through to:
 *
 *   1. VPS dedicated exit — an OpenAI-compatible endpoint on the VPS egress,
 *      capped at 200 requests per day (in-memory counter).
 *   2. NVIDIA NIM — final degradation, using the registered NVIDIA account pool.
 *
 * Both routes are opt-in: without their configuration they are absent and the
 * chain degrades straight to the next configured route.
 */

import type { DirectRoute } from '../../omniroute/adapter.js'
import { loadProviders } from '../../providerRegistry/loader.js'
import { routeLog } from '../../routing/stageLog.js'

/** Daily request cap for the VPS dedicated exit. */
export const DEDICATED_EXIT_DAILY_LIMIT = 200

let usedToday = 0
let countedDay = new Date().toISOString().slice(0, 10)

function currentDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function rollDay(): void {
  const day = currentDay()
  if (countedDay !== day) {
    countedDay = day
    usedToday = 0
  }
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function dedicatedExitLimit(): number {
  const raw = Number(envValue('CCB_OPENCODE_DEDICATED_EXIT_LIMIT'))
  return Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : DEDICATED_EXIT_DAILY_LIMIT
}

/** Test-only: clear the daily dedicated-exit counter. */
export function __resetDedicatedExitForTest(): void {
  rollDay()
  usedToday = 0
}

export function getDedicatedExitUsage(): {
  used: number
  limit: number
  remaining: number
} {
  rollDay()
  const limit = dedicatedExitLimit()
  return { used: usedToday, limit, remaining: Math.max(0, limit - usedToday) }
}

/**
 * Consume one daily slot. Returns false once the cap is reached, which tells
 * the request loop to skip the dedicated exit and fall through to NVIDIA.
 */
export function reserveDedicatedExitSlot(): boolean {
  rollDay()
  const limit = dedicatedExitLimit()
  if (usedToday >= limit) {
    routeLog('fallback', 'dedicated exit quota exhausted', {
      used: usedToday,
      limit,
    })
    return false
  }
  usedToday++
  return true
}

function buildDedicatedExitRoute(model: string): DirectRoute | null {
  const baseURL = envValue('CCB_OPENCODE_DEDICATED_EXIT_BASE_URL')?.replace(
    /\/+$/,
    '',
  )
  const apiKey = envValue('CCB_OPENCODE_DEDICATED_EXIT_KEY')
  if (!baseURL || !apiKey) return null
  return {
    providerId: 'opencode-dedicated',
    baseURL,
    model: envValue('CCB_OPENCODE_DEDICATED_EXIT_MODEL') ?? model,
    apiKey,
    kind: 'provider',
    tier: 'l2',
  }
}

function buildNvidiaRoutes(): DirectRoute[] {
  const provider = loadProviders().find(entry => entry.id === 'nvidia')
  if (!provider) return []
  const baseURL = (envValue('NVIDIA_NIM_BASE_URL') ?? provider.baseUrl)
    .replace(/\/(?:chat\/completions|responses)\/?$/, '')
    .replace(/\/+$/, '')
  const model = envValue('NVIDIA_NIM_FALLBACK_MODEL') ?? provider.defaultModel
  if (!model) return []
  return (provider.accounts ?? [])
    .filter(account => account.enabled !== false)
    .flatMap(account => {
      const apiKey =
        account.apiKey ??
        (account.apiKeyEnv ? envValue(account.apiKeyEnv) : undefined)
      if (!apiKey) return []
      return [
        {
          providerId: 'nvidia',
          baseURL,
          model: account.model ?? model,
          apiKey,
          headers: provider.headers,
          timeoutMs: provider.timeoutMs,
          compatRule: provider.compatRule,
          accountId: account.id,
          kind: 'provider' as const,
          tier: 'l3' as const,
        },
      ]
    })
}

/**
 * Append the VPS dedicated exit and NVIDIA NIM routes after the last opencode
 * route, so every public opencode entry is tried before the paid fallbacks.
 * Inserted once per array, never once per opencode route.
 * Returns the input routes unchanged when nothing is configured.
 */
export function expandOpencodeFallbackRoutes(
  routes: readonly DirectRoute[],
): DirectRoute[] {
  if (routes.length === 0) return []
  const nvidiaRoutes = buildNvidiaRoutes()
  let lastOpenCode = -1
  for (let i = routes.length - 1; i >= 0; i--) {
    if (routes[i]?.kind === 'opencode') {
      lastOpenCode = i
      break
    }
  }
  if (lastOpenCode === -1) return [...routes]
  const dedicated = buildDedicatedExitRoute(routes[lastOpenCode]!.model)
  if (!dedicated && nvidiaRoutes.length === 0) return [...routes]
  const expanded: DirectRoute[] = []
  for (const [i, route] of routes.entries()) {
    expanded.push(route)
    if (i !== lastOpenCode) continue
    if (dedicated) expanded.push(dedicated)
    expanded.push(...nvidiaRoutes)
  }
  return expanded
}
