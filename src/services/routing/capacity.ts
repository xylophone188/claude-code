/**
 * capacity.ts — pure TypeScript port of ccb's capacityAdapter.js fallback logic.
 *
 * ccb's original selects fallback provider/models by required input-modality
 * capabilities (vision / pdf / audio / video), preferring pools with capacity left.
 * This is a dependency-free, no-network/no-DB port focused on the core decision:
 * given a requested capability set and candidate providers, pick the one that
 * supports it, preferring the highest remaining quota as a tiebreaker.
 */

/** Capability flags a model/provider may support. */
export interface ModelCapability {
  vision?: boolean
  longContext?: boolean
  json?: boolean
  functionCalling?: boolean
}

/** A candidate provider carrying capability info and remaining quota. */
export interface CapacityProvider {
  id: string
  capabilities: ModelCapability
  quotaRemaining?: number
}

/**
 * Returns true when provider `p` supports all of the requested capabilities.
 * A capability is "supported" only when the flag is strictly `true`. Absent
 * keys (undefined) are treated as NOT supported.
 */
export function supportsCapabilities(
  p: CapacityProvider,
  req: Partial<ModelCapability>,
): boolean {
  if (!p || !p.capabilities) return false
  for (const key of Object.keys(req) as (keyof ModelCapability)[]) {
    const need = req[key]
    if (need === undefined || need === null) continue
    if (p.capabilities[key] !== true) return false
  }
  return true
}

/**
 * Selects the best candidate that supports every requested capability.
 *
 * Among capable candidates, the one with the highest `quotaRemaining` wins
 * (closest to infinity / no quota field = treated as lowest priority among
 * those lacking a number, but still a valid pick). If no candidate supports
 * all requested capabilities, returns `undefined` (matches ccb's
 * "leave the original list untouched / no-op" fallback behavior).
 */
export function selectByCapacity(
  requested: Partial<ModelCapability>,
  candidates: CapacityProvider[],
): CapacityProvider | undefined {
  if (!Array.isArray(candidates)) return undefined

  const capable = candidates.filter(p => supportsCapabilities(p, requested))
  if (capable.length === 0) return undefined

  return capable.reduce((best, cur) => {
    const bestQ = best.quotaRemaining ?? -Infinity
    const curQ = cur.quotaRemaining ?? -Infinity
    return curQ > bestQ ? cur : best
  })
}
