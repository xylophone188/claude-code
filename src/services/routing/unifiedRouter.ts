/**
 * CCB unified router — single fold point for direct providers and advisor.
 *
 * PURE: no network, no DB, no global mutable state. Safe to call anywhere.
 *
 * Resolution order (per unifiedResolve):
 *   1. ccbRouting   — resolveModel(specOrPrompt)
 *   2. advisor   — specOrPrompt === "advisor", or a bare prompt when opts.advisorFallback
 *   3. otherwise undefined
 */
import { resolveModel, pickComboModel, listProviders } from './resolve.js'
import { routeIntent, isReservedAdvisorName } from './advisor.js'
import type { CCBRoutingProvider } from './types.js'

export interface UnifiedRoute {
  kind: 'ccbRouting' | 'advisor'
  id: string
  baseUrl: string
  model: string
  apiKeyEnv?: string
}

export interface UnifiedResolveOpts {
  /** When true, unresolved bare specs are routed through advisor.routeIntent. */
  advisorFallback?: boolean
}

function ccbRoutingRoute(
  provider: CCBRoutingProvider,
  model: string,
): UnifiedRoute {
  return {
    kind: 'ccbRouting',
    id: provider.id,
    baseUrl: provider.baseUrl,
    model,
    apiKeyEnv: provider.apiKeyEnv,
  }
}

/** Route a prompt through advisor intent classification to a concrete route. */
function advisorRoute(prompt: string): UnifiedRoute {
  const { model } = routeIntent(prompt)
  const adv = resolveModel(model)
  if (adv && 'provider' in adv) {
    return {
      kind: 'advisor',
      id: adv.provider.id,
      baseUrl: adv.provider.baseUrl,
      model: adv.model,
      apiKeyEnv: adv.provider.apiKeyEnv,
    }
  }
  // Advisor model did not resolve to a known ccbRouting provider; surface raw parts.
  const slash = model.indexOf('/')
  return {
    kind: 'advisor',
    id: slash >= 0 ? model.slice(0, slash) : model,
    baseUrl: '',
    model: slash >= 0 ? model.slice(slash + 1) : model,
  }
}

/**
 * Resolve a spec or prompt against direct providers and advisor.
 * Returns the first concrete route found, or undefined.
 *
 * Order:
 *   0. Reserved advisor virtual model ("advisor") — takes priority over the
 *      ccbRouting "advisor" -> "advisor-combo" alias.
 *   1. ccbRouting   — resolveModel(specOrPrompt)
 *   2. advisor   — bare prompt via opts.advisorFallback
 */
export function unifiedResolve(
  specOrPrompt: string,
  opts?: UnifiedResolveOpts,
): UnifiedRoute | undefined {
  if (!specOrPrompt) return undefined

  // 0. Reserved advisor virtual model (shadow the ccbRouting alias).
  if (isReservedAdvisorName(specOrPrompt)) {
    return advisorRoute(specOrPrompt)
  }

  // 1. ccbRouting resolution.
  const resolved = resolveModel(specOrPrompt)
  if (resolved) {
    if ('provider' in resolved) {
      return ccbRoutingRoute(resolved.provider, resolved.model)
    }
    // Combo -> resolve its first model's provider.
    const firstModel = pickComboModel(resolved.combo, 0)
    if (firstModel) {
      const firstResolved = resolveModel(firstModel)
      if (firstResolved && 'provider' in firstResolved) {
        return ccbRoutingRoute(firstResolved.provider, firstResolved.model)
      }
    }
    return undefined
  }

  // 2. advisor bare-prompt fallback.
  if (opts?.advisorFallback) {
    return advisorRoute(specOrPrompt)
  }

  return undefined
}

/**
 * Introspection: counts of the two static registries backing unifiedResolve.
 * (advisor is dynamic/top-tier resolution, not a counted registry.)
 */
export function listUnifiedSources(): { ccbRouting: number } {
  return { ccbRouting: listProviders().length }
}
