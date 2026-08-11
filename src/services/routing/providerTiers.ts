/**
 * ccbRouting / providerTiers — cost/intelligence tier classification for providers.
 *
 * PURE: no network, no DB, no global mutable state. Safe to call anywhere.
 *
 * Ports the tier concept from ccb (src/sse/services/providerTiers.js / advisorLayer.js).
 */

import { listProviders } from './resolve.js'

export type TierName = 'frontier' | 'strong' | 'fast' | 'free'

/** Provider prefixes (keyed on the segment before "/") mapped to a tier. */
const TIER_PREFIXES: Record<string, TierName> = {
  openai: 'frontier',
  xai: 'frontier',
  kimi: 'strong',
  deepseek: 'strong',
  groq: 'fast',
  cerebras: 'fast',
  qwen: 'fast',
}

/**
 * Classify a "provider/model" or bare "provider" id into a tier.
 * Unknown prefixes default to 'free'.
 */
export function tierOfProvider(id: string): TierName {
  if (!id) return 'free'
  const prefix = id.includes('/') ? id.slice(0, id.indexOf('/')) : id
  return TIER_PREFIXES[prefix] ?? 'free'
}

/** Numeric rank for sorting/comparison: frontier=3, strong=2, fast=1, free=0. */
export function tierRank(t: TierName): number {
  switch (t) {
    case 'frontier':
      return 3
    case 'strong':
      return 2
    case 'fast':
      return 1
    case 'free':
      return 0
  }
}

/**
 * Group all CCB_ROUTING_PROVIDERS (via resolve.listProviders()) by tier.
 * Returns a record with all four tier keys always present.
 */
export function providersByTier(): Record<TierName, string[]> {
  const result: Record<TierName, string[]> = {
    frontier: [],
    strong: [],
    fast: [],
    free: [],
  }
  for (const p of listProviders()) {
    result[tierOfProvider(p.id)].push(p.id)
  }
  return result
}
