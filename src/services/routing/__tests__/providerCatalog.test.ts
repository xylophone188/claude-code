import { describe, it, expect } from 'bun:test'
import { listProviders } from '../resolve.js'
import {
  buildCatalog,
  catalogToJson,
  type ProviderCatalog,
} from '../providerCatalog.js'
import { CCB_ROUTING_COMBOS, CCB_ROUTING_ALIASES } from '../combos.js'
import { DEFAULT_ADVISOR_TIERS } from '../advisor.js'

describe('providerCatalog', () => {
  it('buildCatalog returns the expected shape', () => {
    const cat = buildCatalog()
    expect(cat).toHaveProperty('providers')
    expect(cat).toHaveProperty('combos')
    expect(cat).toHaveProperty('aliases')
    expect(cat).toHaveProperty('advisorTiers')
    expect(typeof cat.generatedAt).toBe('number')
    expect(typeof cat.total).toBe('number')
  })

  it('total matches listProviders length and providers array', () => {
    const cat = buildCatalog()
    const providers = listProviders()
    expect(cat.providers).toBe(providers)
    expect(cat.total).toBe(providers.length)
    expect(cat.total).toBeGreaterThan(0)
  })

  it('catalogToJson parses back into an equivalent catalog', () => {
    const json = catalogToJson(2)
    const parsed = JSON.parse(json) as ProviderCatalog
    const direct = buildCatalog()
    expect(parsed.total).toBe(direct.total)
    expect(parsed.providers.length).toBe(direct.providers.length)
    expect(parsed.combos.length).toBe(direct.combos.length)
    expect(parsed.aliases.length).toBe(direct.aliases.length)
    expect(parsed.advisorTiers.length).toBe(direct.advisorTiers.length)
  })

  it('catalogToJson respects indent and excludes volatile timestamp on value', () => {
    const pretty = catalogToJson(2)
    const compact = catalogToJson(0)
    expect(pretty).toContain('\n')
    expect(compact).not.toContain('\n')
    // generatedAt reconstructs on every build — just assert it is a number in both.
    expect(typeof JSON.parse(pretty).generatedAt).toBe('number')
    expect(typeof JSON.parse(compact).generatedAt).toBe('number')
  })

  it('combos/aliases/advisorTiers come from the real registries', () => {
    const cat = buildCatalog()
    expect(cat.combos).toBe(CCB_ROUTING_COMBOS)
    expect(cat.aliases).toBe(CCB_ROUTING_ALIASES)
    expect(cat.advisorTiers).toBe(DEFAULT_ADVISOR_TIERS)
  })
})
