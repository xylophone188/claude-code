/**
 * ccbRouting / providerCatalog — serializable catalog builder.
 *
 * PURE: composes the real registries (providers, combos, aliases, advisor tiers)
 * into a single JSON-friendly structure for `/router --json` and documentation.
 * No network, no DB, no invented ids — every entry comes from the live registry.
 */
import { listProviders } from './resolve.js'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from './combos.js'
import { DEFAULT_ADVISOR_TIERS } from './advisor.js'

export interface ProviderCatalog {
  providers: unknown[]
  combos: unknown[]
  aliases: unknown[]
  advisorTiers: unknown[]
  generatedAt: number
  total: number
}

/** Build a serializable snapshot of the ccbRouting registry. */
export function buildCatalog(): ProviderCatalog {
  const providers = listProviders()
  const combos = CCB_ROUTING_COMBOS
  const aliases = CCB_ROUTING_ALIASES
  const advisorTiers = DEFAULT_ADVISOR_TIERS
  return {
    providers,
    combos,
    aliases,
    advisorTiers,
    generatedAt: Date.now(),
    total: providers.length,
  }
}

/** Serialize the catalog to JSON with the given indentation. */
export function catalogToJson(indent = 2): string {
  return JSON.stringify(buildCatalog(), null, indent)
}
