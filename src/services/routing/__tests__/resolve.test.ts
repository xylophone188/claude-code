import { describe, it, expect } from 'bun:test'
import {
  resolveModel,
  resolveProvider,
  listProviders,
  pickComboModel,
} from '../resolve'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from '../combos'

const allComboNames = new Set(CCB_ROUTING_COMBOS.map(c => c.name))
const allProviderIds = new Set(listProviders().map(p => p.id))

describe('resolveModel', () => {
  it("resolves 'advisor' alias to the advisor combo", () => {
    const r = resolveModel('advisor')
    expect(r).toBeDefined()
    expect(r).toHaveProperty('combo')
    if (r && 'combo' in r) {
      expect(r.combo.name).toBe('advisor-combo')
    }
  })

  it("resolves a 'provider/model' spec", () => {
    // Build a spec from an existing provider + its default model so the test
    // does not depend on a hard-coded id being present.
    const provider = listProviders().find(p => p.defaultModel)
    expect(provider).toBeDefined()
    const model = provider!.defaultModel!
    const r = resolveModel(`${provider!.id}/${model}`)
    expect(r).toBeDefined()
    expect(r).toHaveProperty('provider')
    if (r && 'provider' in r) {
      expect(r.provider.id).toBe(provider!.id)
      expect(r.model).toBe(model)
    }
  })

  it('resolves a bare provider id to its default model', () => {
    const provider = listProviders()[0]
    const r = resolveModel(provider.id)
    expect(r).toBeDefined()
    expect(r).toHaveProperty('provider')
    if (r && 'provider' in r) {
      expect(r.provider.id).toBe(provider.id)
    }
  })

  it('returns undefined for an unknown spec', () => {
    expect(resolveModel('no-such-model-xyz')).toBeUndefined()
    expect(resolveModel('')).toBeUndefined()
  })

  it('resolves an alias to its target', () => {
    const alias = CCB_ROUTING_ALIASES[0]
    const r = resolveModel(alias.alias)
    expect(r).toBeDefined()
    // target is either a combo name or a provider/model spec; both must resolve.
    const viaTarget = resolveModel(alias.target)
    expect(viaTarget).toBeDefined()
    expect(JSON.stringify(r)).toBe(JSON.stringify(viaTarget))
  })
})

describe('resolveProvider', () => {
  it('returns a provider for a known id', () => {
    const provider = listProviders()[0]
    expect(resolveProvider(provider.id)?.id).toBe(provider.id)
  })

  it('returns undefined for an unknown id', () => {
    expect(resolveProvider('no-such-provider-xyz')).toBeUndefined()
    expect(resolveProvider('')).toBeUndefined()
  })
})

describe('pickComboModel', () => {
  it('fallback returns the Nth model (clamped to last)', () => {
    const combo = CCB_ROUTING_COMBOS.find(c => c.strategy === 'fallback')!
    expect(pickComboModel(combo, 0)).toBe(combo.models[0])
    expect(pickComboModel(combo, 2)).toBe(combo.models[2])
    expect(pickComboModel(combo, 999)).toBe(
      combo.models[combo.models.length - 1],
    )
    expect(pickComboModel(combo, -1)).toBe(combo.models[0])
  })

  it('sticky-round-robin rotates every stickyLimit', () => {
    const combo = CCB_ROUTING_COMBOS.find(
      c => c.strategy === 'sticky-round-robin',
    )!
    const limit = combo.stickyLimit || 1
    // first `limit` attempts stay on model 0
    expect(pickComboModel(combo, 0)).toBe(combo.models[0])
    expect(pickComboModel(combo, limit - 1)).toBe(combo.models[0])
    // next block moves to model 1
    expect(pickComboModel(combo, limit)).toBe(
      combo.models[1 % combo.models.length],
    )
    // wraps around
    const big = limit * combo.models.length
    expect(pickComboModel(combo, big)).toBe(combo.models[0])
  })

  it('fusion round-robins across the panel', () => {
    const combo = CCB_ROUTING_COMBOS.find(c => c.strategy === 'fusion')!
    const n = combo.models.length
    expect(pickComboModel(combo, 0)).toBe(combo.models[0])
    expect(pickComboModel(combo, 1)).toBe(combo.models[1])
    expect(pickComboModel(combo, n)).toBe(combo.models[0])
  })

  it('returns undefined for a combo with no models', () => {
    expect(
      pickComboModel({ name: 'empty', strategy: 'fallback', models: [] }),
    ).toBeUndefined()
  })
})

describe('registry + alias integrity', () => {
  it('combos and aliases are non-empty arrays', () => {
    expect(Array.isArray(CCB_ROUTING_COMBOS)).toBe(true)
    expect(Array.isArray(CCB_ROUTING_ALIASES)).toBe(true)
    expect(CCB_ROUTING_COMBOS.length).toBeGreaterThan(0)
    expect(CCB_ROUTING_ALIASES.length).toBeGreaterThan(0)
  })

  it('alias targets are valid provider ids or combo names', () => {
    for (const a of CCB_ROUTING_ALIASES) {
      const isCombo = allComboNames.has(a.target)
      const isProvider = allProviderIds.has(a.target)
      // target may itself be "provider/model"; check the provider prefix
      const slashTarget = a.target.includes('/')
        ? allProviderIds.has(a.target.split('/')[0])
        : false
      expect(isCombo || isProvider || slashTarget).toBe(true)
    }
  })

  it('every combo model id has a resolvable provider prefix', () => {
    for (const c of CCB_ROUTING_COMBOS) {
      for (const m of c.models) {
        const slash = m.indexOf('/')
        expect(slash).toBeGreaterThan(0)
        const pid = m.slice(0, slash)
        expect(allProviderIds.has(pid)).toBe(true)
      }
    }
  })
})
