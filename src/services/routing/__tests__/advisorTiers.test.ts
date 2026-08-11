import { describe, expect, test } from 'bun:test'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from '../combos.js'
import { resolveModel } from '../resolve.js'

const tierCombos = new Map(
  CCB_ROUTING_COMBOS.filter(c => c.name.startsWith('advisor-')).map(c => [
    c.name,
    c,
  ]),
)

describe('four-tier advisor (lite/full/ultra/review)', () => {
  test('defines all four advisor tier combos', () => {
    for (const name of [
      'advisor-lite',
      'advisor-full',
      'advisor-ultra',
      'advisor-review',
    ]) {
      expect(tierCombos.has(name), `missing combo ${name}`).toBe(true)
    }
  })

  test('aliases route lite/full/ultra/review to their combos', () => {
    const aliasTargets = new Map(
      CCB_ROUTING_ALIASES.map(a => [a.alias, a.target]),
    )
    for (const [alias, target] of [
      ['lite', 'advisor-lite'],
      ['full', 'advisor-full'],
      ['ultra', 'advisor-ultra'],
      ['review', 'advisor-review'],
    ] as const) {
      expect(aliasTargets.get(alias)).toBe(target)
    }
  })

  test('resolveModel resolves each tier alias to its combo', () => {
    for (const tier of ['lite', 'full', 'ultra', 'review'] as const) {
      const resolved = resolveModel(tier)
      expect(resolved, `${tier} should resolve`).toBeDefined()
      expect('combo' in resolved!).toBe(true)
      if ('combo' in resolved!) {
        expect(resolved.combo.name).toBe(`advisor-${tier}`)
      }
    }
  })

  test('ultra is a stricter subset than lite', () => {
    const ultra = tierCombos.get('advisor-ultra')!
    const lite = tierCombos.get('advisor-lite')!
    // ultra leads with frontier models; lite leads with cheaper fallbacks
    expect(ultra.models).toContain('openai/gpt-5.4')
    expect(lite.models[0]).toBe('deepseek/deepseek-v4-pro')
  })
})
