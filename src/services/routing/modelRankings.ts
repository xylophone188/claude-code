/**
 * ccbRouting / model-rankings — ranking sync + lookup.
 *
 * Pure TS, async-friendly. Network/IO is injected via a fetcher so this module
 * can be unit-tested without any external dependency (no build, no SQLite/DB).
 */

import { DEFAULT_ADVISOR_TIERS } from './advisor.js'

export interface ModelRanking {
  id: string
  score: number
  tier?: string
}

export interface Rankings {
  updatedAt: number
  models: ModelRanking[]
}

/**
 * Intent -> tier mapping. Mirrors routeIntent in advisor.ts:
 *   advisory -> top tier (highest intelligence), work -> last tier (cheapest).
 * Used by rankForIntent/topModel to filter when an intent implies a tier.
 */
const INTENT_TIER: Record<'advisory' | 'work', string> = {
  advisory: DEFAULT_ADVISOR_TIERS[0].name,
  work: DEFAULT_ADVISOR_TIERS[DEFAULT_ADVISOR_TIERS.length - 1].name,
}

/**
 * Derive a default ranking from DEFAULT_ADVISOR_TIERS. The top tier scores
 * highest and scores descend as we move down the chain. Only real model ids
 * from the shipped tier config are used.
 */
export function defaultRankings(): Rankings {
  const models: ModelRanking[] = []
  let score = 100
  for (const tier of DEFAULT_ADVISOR_TIERS) {
    for (const id of tier.models) {
      models.push({ id, score, tier: tier.name })
      score -= 10
    }
  }
  // Defensive sort: guarantee descending score order regardless of input order.
  models.sort((a, b) => b.score - a.score)
  return { updatedAt: 0, models }
}

/**
 * Load rankings. If a fetcher is provided, call it; otherwise return defaults.
 * The fetcher is injected so callers can supply network/IO without coupling
 * tests to any external system.
 */
export async function loadRankings(
  fetcher?: () => Promise<Rankings>,
): Promise<Rankings> {
  if (fetcher) return fetcher()
  return defaultRankings()
}

/**
 * Return models sorted by score descending, filtered to the intent's mapped
 * tier when the intent implies one (advisory -> top tier, work -> last tier).
 */
export function rankForIntent(
  rankings: Rankings,
  intent: 'advisory' | 'work',
): ModelRanking[] {
  const tierName = INTENT_TIER[intent]
  const filtered = rankings.models.filter(m => m.tier === tierName)
  return [...filtered].sort((a, b) => b.score - a.score)
}

/**
 * Convenience: return the highest-ranked model id. When an intent is given,
 * the lookup is scoped to that intent's tier via rankForIntent.
 */
export function topModel(
  rankings: Rankings,
  intent?: 'advisory' | 'work',
): string | undefined {
  const list = intent ? rankForIntent(rankings, intent) : rankings.models
  if (list.length === 0) return undefined
  return [...list].sort((a, b) => b.score - a.score)[0].id
}
