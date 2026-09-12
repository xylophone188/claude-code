/**
 * scenarioCombos.ts — per-scenario degradation chains across the L1–L7 quota
 * axis for the CCB local router.
 *
 * `combos.ts` defines *static* fallback/fusion chains over concrete models.
 * This module plans the *order of attack* over quota tiers: the same coding
 * task is first served from the L1 race pool (never rationed), then from the
 * scarce 5h (L2) window while it lasts, then daily (L3) / weekly (L4) /
 * monthly (L5), then one-shot (L6) credits that must be burned before they
 * expire, and only as a permanent last resort L7.
 *
 * PURE and in-memory: no network, no DB, no timers. Callers pass admission
 * and breaker state in; the planner never talks to quotaGate / circuitBreaker.
 */

import type { QuotaClass } from './quotaGate.js'

export const SCENARIO_TIER_ORDER: readonly QuotaClass[] = [
  'l1',
  'l2',
  'l3',
  'l4',
  'l5',
  'l6',
  'l7',
] as const

export interface ScenarioComboItem {
  /** Quota tier this item consumes. */
  className: QuotaClass
  /** Combos (from combos.ts) tried in order within this tier. */
  combos: string[]
}

export interface ScenarioCombo {
  name: string
  tiers: ScenarioComboItem[]
}

export interface ScenarioCombosConfig {
  /**
   * Tiers skipped for a scenario, in preference order. Defaults to nothing
   * skipped, which keeps the full degradation chain intact.
   */
  skipTiers?: QuotaClass[]
}

/** Health evidence the planner evaluates against. Each entry is optional so a
 *  caller can start with the default (all healthy) and fill in what it knows. */
export interface ScenarioComboHealth {
  /** Quota tier is exhausted or below its floor (from quotaGate). */
  quotaBlocked?: Partial<Record<QuotaClass, boolean>>
  /** Provider/model circuit is open (from circuitBreaker). */
  circuitOpen?: Partial<Record<QuotaClass, boolean>>
  /** Whole chain may be skipped (e.g. interactive session veto). */
  blocked?: boolean
}

export interface ScenarioPlanResult {
  scenario: string
  selected: ScenarioComboItem | null
  tier: QuotaClass | null
  combos: string[]
  skipped: QuotaClass[]
  blockedTiers: QuotaClass[]
}

const DEFAULT_COMBOS: Record<string, string[]> = {
  l1: ['fast-rr'],
  l2: ['advisor-full'],
  l3: ['advisor-lite'],
  l4: ['advisor-lite'],
  l5: ['advisor-lite'],
  l6: ['advisor-combo'],
  l7: ['advisor-lite'],
}

const DEFAULT_SCENARIOS: ScenarioCombo[] = [
  {
    name: 'coding',
    tiers: [
      { className: 'l1', combos: ['fast-rr', 'advisor-ultra'] },
      { className: 'l2', combos: ['advisor-full'] },
      { className: 'l3', combos: ['advisor-lite'] },
      { className: 'l4', combos: ['advisor-lite'] },
      { className: 'l5', combos: ['advisor-lite'] },
      { className: 'l6', combos: ['advisor-combo'] },
      { className: 'l7', combos: ['advisor-lite'] },
    ],
  },
  {
    name: 'chat',
    tiers: [
      { className: 'l1', combos: ['fast-rr'] },
      { className: 'l2', combos: ['advisor-lite'] },
      { className: 'l3', combos: ['advisor-lite'] },
      { className: 'l4', combos: ['advisor-lite'] },
      { className: 'l5', combos: ['advisor-lite'] },
      { className: 'l6', combos: ['advisor-lite'] },
      { className: 'l7', combos: ['advisor-lite'] },
    ],
  },
  {
    name: 'advisor',
    tiers: [
      { className: 'l1', combos: ['advisor-ultra', 'advisor-full'] },
      { className: 'l2', combos: ['advisor-full'] },
      { className: 'l3', combos: ['advisor-lite'] },
      { className: 'l4', combos: ['advisor-lite'] },
      { className: 'l5', combos: ['advisor-lite'] },
      { className: 'l6', combos: ['advisor-full'] },
      { className: 'l7', combos: ['advisor-lite'] },
    ],
  },
  {
    name: 'vision',
    tiers: [
      { className: 'l1', combos: ['advisor-ultra'] },
      { className: 'l2', combos: ['advisor-full'] },
      { className: 'l3', combos: ['advisor-lite'] },
      { className: 'l4', combos: ['advisor-lite'] },
      { className: 'l5', combos: ['advisor-lite'] },
      { className: 'l6', combos: ['advisor-combo'] },
      { className: 'l7', combos: ['advisor-lite'] },
    ],
  },
]

export function scenarioTierOrder(
  config: ScenarioCombosConfig = {},
): QuotaClass[] {
  const skip = new Set(config.skipTiers ?? [])
  return SCENARIO_TIER_ORDER.filter(tier => !skip.has(tier))
}

export function scenarioCombosFor(
  scenario: string,
  combos: ScenarioCombo[] = DEFAULT_SCENARIOS,
): ScenarioCombo | null {
  return combos.find(candidate => candidate.name === scenario) ?? null
}

export function planScenarioCombos(
  scenario: string,
  health: ScenarioComboHealth = {},
  config: ScenarioCombosConfig = {},
  combos: ScenarioCombo[] = DEFAULT_SCENARIOS,
): ScenarioPlanResult {
  const skip = new Set(config.skipTiers ?? [])
  const definition = scenarioCombosFor(scenario, combos)
  const tiers = definition
    ? definition.tiers
    : SCENARIO_TIER_ORDER.map(tier => ({
        className: tier,
        combos: DEFAULT_COMBOS[tier] ?? [],
      }))
  const selectedTiers = tiers.filter(item => !skip.has(item.className))
  const quotaBlocked = health.quotaBlocked ?? {}
  const circuitOpen = health.circuitOpen ?? {}

  for (const item of selectedTiers) {
    const blocked =
      quotaBlocked[item.className] === true ||
      circuitOpen[item.className] === true
    if (blocked) continue
    if (health.blocked === true && item.className !== 'l7') continue
    return {
      scenario,
      selected: item,
      tier: item.className,
      combos: item.combos,
      skipped: [...skip],
      blockedTiers: tiers
        .filter(
          t =>
            quotaBlocked[t.className] === true ||
            circuitOpen[t.className] === true,
        )
        .map(t => t.className),
    }
  }

  return {
    scenario,
    selected: null,
    tier: null,
    combos: [],
    skipped: [...skip],
    blockedTiers: selectedTiers.map(item => item.className),
  }
}
