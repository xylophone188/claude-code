/**
 * ccbRouting / settingsSync — injectable settings-sync module.
 *
 * Mirrors ccb's cron "settings-sync" (src/sse/cron-jobs.js / settingsRepo.js):
 * collect the current combo/alias/advisor-tier config and push it to a remote
 * endpoint. Transport is INJECTED so the module stays PURE (no real network),
 * which makes it directly testable.
 *
 * PURE: no network, no DB, no global mutable state.
 */

import { CCB_ROUTING_COMBOS } from './combos.js'
import { CCB_ROUTING_ALIASES } from './combos.js'
import { DEFAULT_ADVISOR_TIERS } from './advisor.js'

/** Snapshot of the ccbRouting config at a point in time. */
export interface CCBRoutingSettings {
  combos: unknown[]
  aliases: unknown[]
  advisorTiers: unknown[]
  generatedAt: number
}

/** A transport pushes a settings payload somewhere (network, queue, file, …). */
export type Transport = (payload: CCBRoutingSettings) => Promise<void>

/** Pure builder: returns the current combos, aliases, advisor tiers + a timestamp. */
export function collectSettings(): CCBRoutingSettings {
  return {
    combos: CCB_ROUTING_COMBOS,
    aliases: CCB_ROUTING_ALIASES,
    advisorTiers: DEFAULT_ADVISOR_TIERS,
    generatedAt: Date.now(),
  }
}

/**
 * Collect settings (unless a snapshot is provided) and push via the injected
 * transport. The transport owns the actual delivery (network/filesystem), so
 * this function itself performs no I/O.
 */
export async function syncSettings(
  transport: Transport,
  settings?: CCBRoutingSettings,
): Promise<void> {
  const payload = settings ?? collectSettings()
  await transport(payload)
}

/**
 * Compare two settings snapshots and return the list of changed top-level keys
 * ("combos" | "aliases" | "advisorTiers" | "generatedAt"). Two values are
 * considered equal via JSON serialization.
 */
export function diffSettings(
  a: CCBRoutingSettings,
  b: CCBRoutingSettings,
): string[] {
  const keys: (keyof CCBRoutingSettings)[] = [
    'combos',
    'aliases',
    'advisorTiers',
    'generatedAt',
  ]
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      changed.push(key)
    }
  }
  return changed
}
