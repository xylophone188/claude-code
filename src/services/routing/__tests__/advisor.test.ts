import { describe, it, expect } from 'bun:test'
import {
  ADVISOR_VIRTUAL_MODEL,
  ADVISOR_COMBO_NAME,
  isReservedAdvisorName,
  DEFAULT_ADVISOR_TIERS,
  QUOTA_TARGET_PER_HOUR,
  routeIntent,
  type AdvisorTier,
} from '../advisor'

describe('isReservedAdvisorName', () => {
  it("reserves the bare 'advisor' name", () => {
    expect(isReservedAdvisorName('advisor')).toBe(true)
  })

  it("does NOT reserve 'advisor-combo'", () => {
    expect(isReservedAdvisorName('advisor-combo')).toBe(false)
  })

  it('returns false for a random name', () => {
    expect(isReservedAdvisorName('gpt-5')).toBe(false)
  })
})

describe('constants', () => {
  it('exposes the expected virtual model + combo name', () => {
    expect(ADVISOR_VIRTUAL_MODEL).toBe('advisor')
    expect(ADVISOR_COMBO_NAME).toBe('advisor-combo')
  })

  it('has a non-empty quota target', () => {
    expect(QUOTA_TARGET_PER_HOUR).toBeGreaterThan(0)
  })
})

describe('DEFAULT_ADVISOR_TIERS', () => {
  it('is a non-empty array of {name, models[]} with non-empty models', () => {
    expect(Array.isArray(DEFAULT_ADVISOR_TIERS)).toBe(true)
    expect(DEFAULT_ADVISOR_TIERS.length).toBeGreaterThan(0)
    for (const tier of DEFAULT_ADVISOR_TIERS) {
      expect(typeof tier.name).toBe('string')
      expect(tier.name.length).toBeGreaterThan(0)
      expect(Array.isArray(tier.models)).toBe(true)
      expect(tier.models.length).toBeGreaterThan(0)
      for (const m of tier.models) {
        expect(typeof m).toBe('string')
        expect(m.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('routeIntent', () => {
  it("returns a non-empty model from DEFAULT_ADVISOR_TIERS for 'advisor'", () => {
    const { model } = routeIntent('advisor')
    expect(typeof model).toBe('string')
    expect(model.length).toBeGreaterThan(0)
    const allModels = DEFAULT_ADVISOR_TIERS.flatMap(
      (t: AdvisorTier) => t.models,
    )
    expect(allModels).toContain(model)
  })

  it('honors a custom tier list', () => {
    const customTiers: AdvisorTier[] = [
      { name: 'custom-top', models: ['model-A'] },
      { name: 'custom-bottom', models: ['model-B'] },
    ]
    const { model } = routeIntent('advisor', { tiers: customTiers })
    const customModels = customTiers.flatMap((t: AdvisorTier) => t.models)
    expect(customModels).toContain(model)
    expect(model).toBe('model-A')
  })
})
