/**
 * CCB bootstrap — startup validation + catalog bootstrap.
 *
 * Validates CCB's direct registry at startup. Catches dangling
 * references (combo/alias/tier pointing at a non-existent provider) BEFORE any
 * request is routed — this is the bug fixed earlier where a stale model id
 * silently broke routing.
 *
 * PURE: validation + catalog building only. No network, no spawning, no global
 * mutable state. Safe to call at process startup or inside a unit test.
 */
import { resolveProvider, resolveModel } from './resolve.js'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from './combos.js'
import { DEFAULT_ADVISOR_TIERS, type AdvisorTier } from './advisor.js'
import { buildCatalog, type ProviderCatalog } from './providerCatalog.js'
import type { CCBRoutingCombo, CCBRoutingAlias } from './types.js'

/** The slice of the registry validateRegistry / bootstrapCCBRouting operate on. */
export interface RegistryInput {
  combos?: CCBRoutingCombo[]
  aliases?: CCBRoutingAlias[]
  tiers?: AdvisorTier[]
}

/** Result of a registry validation pass. */
export interface ValidationResult {
  ok: boolean
  dangling: string[]
}

/** Strip a "provider/model" spec down to the provider id (text before first '/'). */
function providerIdOf(spec: string): string {
  const slash = spec.indexOf('/')
  return slash === -1 ? spec : spec.slice(0, slash)
}

/**
 * Validate CCB's direct registry for dangling references.
 *
 * Scans:
 *   - every combo.models entry  -> must resolve via resolveProvider (provider id).
 *   - every alias.target        -> must resolve via resolveModel (combo or provider/model).
 *   - every advisor tier model  -> must resolve via resolveProvider (provider id).
 *
 * Each dangling entry is tagged with a prefix so the source is obvious, e.g.
 *   "combo:fast-rr:nope/badmodel" | "alias:opus:nope/x" | "advisor:frontier:nope/y".
 *
 * `input` is optional and defaults to the live module registries; passing a
 * custom input is only used by tests to exercise the dangling path.
 */
export function validateRegistry(input?: RegistryInput): ValidationResult {
  const combos = input?.combos ?? CCB_ROUTING_COMBOS
  const aliases = input?.aliases ?? CCB_ROUTING_ALIASES
  const tiers = input?.tiers ?? DEFAULT_ADVISOR_TIERS

  const dangling: string[] = []

  // 1. Combo models -> provider id must exist.
  for (const combo of combos) {
    for (const model of combo.models || []) {
      if (!resolveProvider(providerIdOf(model))) {
        dangling.push(`combo:${combo.name}:${model}`)
      }
    }
  }

  // 2. Alias targets -> must resolve (combo name or provider/model).
  for (const alias of aliases) {
    if (!resolveModel(alias.target)) {
      dangling.push(`alias:${alias.alias}:${alias.target}`)
    }
  }

  // 3. Advisor tier models -> provider id must exist.
  for (const tier of tiers) {
    for (const model of tier.models || []) {
      if (!resolveProvider(providerIdOf(model))) {
        dangling.push(`advisor:${tier.name}:${model}`)
      }
    }
  }

  return { ok: dangling.length === 0, dangling }
}

export interface BootstrapOptions {
  throwOnDangling?: boolean
  registry?: RegistryInput
}

export interface BootstrapResult {
  ok: boolean
  dangling: string[]
  catalog: ProviderCatalog
}

/**
 * Startup bootstrap/validator for CCB.
 *
 * Runs validateRegistry(); if `throwOnDangling` is set and the registry is not
 * ok, throws (fail-fast startup). Otherwise returns the validation result plus
 * a provider catalog. PURE — no spawning/network.
 */
export function bootstrapCCBRouting(opts?: BootstrapOptions): BootstrapResult {
  const result = validateRegistry(opts?.registry)
  if (opts?.throwOnDangling && !result.ok) {
    throw new Error(
      `ccbRouting bootstrap failed: dangling references: ${result.dangling.join(', ')}`,
    )
  }
  return { ...result, catalog: buildCatalog() }
}
