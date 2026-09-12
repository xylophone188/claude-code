import { describe, expect, it } from 'bun:test'
import {
  SCENARIO_TIER_ORDER,
  planScenarioCombos,
  scenarioCombosFor,
  scenarioTierOrder,
} from '../scenarioCombos.js'

describe('scenarioTierOrder', () => {
  it('defaults to the full L1..L7 degradation chain', () => {
    expect(scenarioTierOrder()).toEqual([
      'l1',
      'l2',
      'l3',
      'l4',
      'l5',
      'l6',
      'l7',
    ])
  })

  it('drops skipped tiers in preference order', () => {
    expect(scenarioTierOrder({ skipTiers: ['l1', 'l6'] })).toEqual([
      'l2',
      'l3',
      'l4',
      'l5',
      'l7',
    ])
  })
})

describe('scenarioCombosFor', () => {
  it('finds a defined scenario', () => {
    expect(scenarioCombosFor('coding')).not.toBeNull()
    expect(scenarioCombosFor('coding')?.tiers[0].className).toBe('l1')
  })

  it('returns null for an undefined scenario', () => {
    expect(scenarioCombosFor('nonexistent')).toBeNull()
  })
})

describe('planScenarioCombos', () => {
  it('selects the L1 race pool first for a healthy coding chain', () => {
    const result = planScenarioCombos('coding')
    expect(result).toMatchObject({
      scenario: 'coding',
      tier: 'l1',
      selected: { className: 'l1' },
    })
    expect(result.combos.length).toBeGreaterThan(0)
    expect(result.blockedTiers).toEqual([])
  })

  it('never plans L7 before an admitted tier exists', () => {
    for (const scenario of ['coding', 'chat', 'advisor', 'vision']) {
      expect(planScenarioCombos(scenario).tier).not.toBe('l7')
    }
  })

  it('skips a quota-exhausted tier and falls through', () => {
    const result = planScenarioCombos('coding', {
      quotaBlocked: { l1: true },
    })
    expect(result.tier).toBe('l2')
    expect(result.blockedTiers).toContain('l1')
  })

  it('skips a circuit-open tier and falls through', () => {
    const result = planScenarioCombos('coding', {
      circuitOpen: { l1: true, l2: true },
    })
    expect(result.tier).toBe('l3')
    expect(result.blockedTiers).toEqual(['l1', 'l2'])
  })

  it('returns null when every tier is blocked', () => {
    const result = planScenarioCombos('coding', {
      quotaBlocked: {
        l1: true,
        l2: true,
        l3: true,
        l4: true,
        l5: true,
        l6: true,
        l7: true,
      },
    })
    expect(result.selected).toBeNull()
    expect(result.tier).toBeNull()
    expect(result.combos).toEqual([])
    expect(result.blockedTiers).toEqual([...SCENARIO_TIER_ORDER])
  })

  it('respects skipTiers before evaluating health', () => {
    const result = planScenarioCombos('coding', {}, { skipTiers: ['l1'] })
    expect(result.tier).toBe('l2')
    expect(result.skipped).toEqual(['l1'])
  })

  it('falls back to the default chain for an undefined scenario', () => {
    const result = planScenarioCombos('unknown-scenario')
    expect(result.tier).toBe('l1')
    expect(result.combos).toEqual(['fast-rr'])
  })

  it('honors a scenario-provided combo override', () => {
    const custom = [
      {
        name: 'coding',
        tiers: [
          { className: 'l1' as const, combos: ['custom-pool'] },
          { className: 'l2' as const, combos: ['custom-5h'] },
        ],
      },
    ]
    const first = planScenarioCombos('coding', {}, {}, custom)
    expect(first.combos).toEqual(['custom-pool'])
    const second = planScenarioCombos(
      'coding',
      { quotaBlocked: { l1: true } },
      {},
      custom,
    )
    expect(second.tier).toBe('l2')
    expect(second.combos).toEqual(['custom-5h'])
  })
})
