/**
 * ccbRouting / inspect — spec inspector.
 *
 * Produces a human-readable breakdown of any model spec by folding the
 * resolve / advisor / combos layers into one view.
 *
 * PURE: no network, no DB, no global mutable state. Safe to call anywhere.
 */
import type { CCBRoutingProvider } from './types.js'
import { resolveModel } from './resolve.js'
import { CCB_ROUTING_ALIASES } from './combos.js'
import { routeIntent, ADVISOR_VIRTUAL_MODEL } from './advisor.js'

export interface InspectResult {
  spec: string
  resolved: boolean
  kind?: 'provider' | 'combo' | 'advisor' | 'alias'
  providerId?: string
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  comboStrategy?: string
  tier?: string
  notes: string[]
}

/** Fill provider-derived fields from a resolved provider. */
function applyProvider(
  out: InspectResult,
  provider: CCBRoutingProvider,
  model: string,
): void {
  out.providerId = provider.id
  out.model = model
  out.baseUrl = provider.baseUrl
  out.apiKeyEnv = provider.apiKeyEnv
}

/** Inspect a single "provider/model" (or bare provider) spec into provider fields. */
function inspectResolvedModel(
  out: InspectResult,
  spec: string,
  providerId: string,
  model: string,
): void {
  const resolved = resolveModel(`${providerId}/${model}`)
  if (resolved && 'provider' in resolved) {
    applyProvider(out, resolved.provider, resolved.model)
  }
}

/**
 * Inspect a model spec.
 *
 *   - "advisor"            -> kind "advisor" (routeIntent -> model + tier -> provider)
 *   - provider/model/alias -> kind "provider" | "alias"
 *   - combo name           -> kind "combo"
 *   - nothing matches      -> resolved=false with a note
 */
export function inspectSpec(spec: string): InspectResult {
  const out: InspectResult = {
    spec,
    resolved: false,
    notes: [],
  }

  // 1. Reserved virtual "advisor" model.
  if (spec === ADVISOR_VIRTUAL_MODEL) {
    const { model, tier } = routeIntent(ADVISOR_VIRTUAL_MODEL)
    const resolved = resolveModel(model)
    if (resolved && 'provider' in resolved) {
      out.resolved = true
      out.kind = 'advisor'
      out.tier = tier
      applyProvider(out, resolved.provider, resolved.model)
      out.notes.push(`advisor routes to tier "${tier}" -> ${model}`)
    } else {
      out.notes.push(
        `advisor tier model "${model}" could not be resolved to a provider`,
      )
    }
    return out
  }

  // 2. Everything else.
  const resolved = resolveModel(spec)
  if (!resolved) {
    out.resolved = false
    out.notes.push(`no provider, combo, or alias matches "${spec}"`)
    return out
  }

  if ('combo' in resolved) {
    const combo = resolved.combo
    out.resolved = true
    out.kind = 'combo'
    out.comboStrategy = combo.strategy
    const firstModel = combo.models?.[0]
    if (firstModel) {
      out.model = firstModel
      const firstResolved = resolveModel(firstModel)
      if (firstResolved && 'provider' in firstResolved) {
        out.providerId = firstResolved.provider.id
        out.baseUrl = firstResolved.provider.baseUrl
        out.apiKeyEnv = firstResolved.provider.apiKeyEnv
      }
    }
    out.notes.push(
      `combo "${combo.name}" (${combo.strategy}) with ${combo.models?.length ?? 0} model(s)`,
    )
    return out
  }

  // "provider" in resolved.
  out.resolved = true
  const isAlias = CCB_ROUTING_ALIASES.some(a => a.alias === spec)
  if (isAlias) {
    out.kind = 'alias'
    out.notes.push(
      `"${spec}" is an alias -> ${resolved.provider.id}/${resolved.model}`,
    )
  } else {
    out.kind = 'provider'
  }
  applyProvider(out, resolved.provider, resolved.model)
  return out
}
