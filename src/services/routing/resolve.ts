/**
 * ccbRouting / resolve — pure model-spec resolution.
 *
 * Ports resolution logic from ccb:
 *   - open-sse/services/model.js  (parseModel: "provider/model" | alias | bare provider)
 *   - open-sse/services/combo.js  (fallback / fusion / sticky-round-robin selection)
 *
 * PURE: no network, no DB, no global mutable state. Safe to call anywhere.
 */
import type { CCBRoutingProvider, CCBRoutingCombo } from './types'
import { CCB_ROUTING_PROVIDERS } from './registry.generated'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from './combos'

/** Lookup a provider by id. */
export function resolveProvider(id: string): CCBRoutingProvider | undefined {
  if (!id) return undefined
  return CCB_ROUTING_PROVIDERS.find(p => p.id === id)
}

/** Return the full provider registry. */
export function listProviders(): CCBRoutingProvider[] {
  return CCB_ROUTING_PROVIDERS
}

export type ResolvedModel =
  | { provider: CCBRoutingProvider; model: string }
  | { combo: CCBRoutingCombo }

/**
 * Resolve a model spec to a concrete provider+model or a combo.
 *
 * Resolution order:
 *   1. Combo name           (e.g. "advisor-combo", "fast-rr")  -> { combo }
 *   2. Alias                (recurses on target)               -> resolved target
 *   3. "provider/model"     (look up provider; use given model)-> { provider, model }
 *   4. Bare provider id     (use provider.defaultModel)        -> { provider, model }
 *
 * Returns undefined when nothing matches.
 */
export function resolveModel(spec: string): ResolvedModel | undefined {
  if (!spec) return undefined

  // 1. Combo name (no slash, matches a known combo).
  const combo = CCB_ROUTING_COMBOS.find(c => c.name === spec)
  if (combo) return { combo }

  // 2. Alias -> recurse on its target (target may be provider/model or a combo name).
  const alias = CCB_ROUTING_ALIASES.find(a => a.alias === spec)
  if (alias) return resolveModel(alias.target)

  // 3. "provider/model" or bare provider id.
  if (spec.includes('/')) {
    const slash = spec.indexOf('/')
    const providerId = spec.slice(0, slash)
    const model = spec.slice(slash + 1)
    const provider = resolveProvider(providerId)
    if (!provider) return undefined
    return { provider, model: model || provider.defaultModel || '' }
  }

  // 4. Bare provider id -> default model.
  const provider = resolveProvider(spec)
  if (provider) return { provider, model: provider.defaultModel || '' }

  return undefined
}

/**
 * Pick the model to use for a given combo + attempt index (0-based).
 *   - fallback:           the Nth model (clamped to last).
 *   - sticky-round-robin: rotates every stickyLimit attempts (round-robin).
 *   - fusion:             the Nth panel model (round-robin across the panel).
 */
export function pickComboModel(
  combo: CCBRoutingCombo,
  attempt = 0,
): string | undefined {
  const models = combo.models || []
  if (models.length === 0) return undefined

  const n = Math.max(0, attempt | 0)

  if (combo.strategy === 'fallback') {
    return models[Math.min(n, models.length - 1)]
  }

  if (combo.strategy === 'sticky-round-robin') {
    const limit = Math.max(1, combo.stickyLimit || 1)
    const idx = Math.floor(n / limit) % models.length
    return models[idx]
  }

  // fusion
  return models[n % models.length]
}
