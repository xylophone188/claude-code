/**
 * ccbRouting / bootstrap test — pure validation, no network/spawn.
 */
import { describe, it, expect } from 'bun:test'
import {
  validateRegistry,
  bootstrapCCBRouting,
  type RegistryInput,
} from '../bootstrap.js'
import { resolveProvider, listProviders } from '../resolve.js'

const BAD_REGISTRY: RegistryInput = {
  combos: [
    {
      name: 'fast-rr',
      strategy: 'sticky-round-robin',
      models: ['groq/llama-3.3-70b-versatile', 'nope/badmodel'],
    },
  ],
  aliases: [{ alias: 'opus', target: 'ghost/missing-model' }],
  tiers: [
    { name: 'frontier', models: ['openai/gpt-5.4'] },
    { name: 'fast', models: ['void/also-missing'] },
  ],
}

describe('ccbRouting validateRegistry', () => {
  it('passes on the real registry (ok=true, no dangling)', () => {
    const res = validateRegistry()
    expect(res.ok).toBe(true)
    expect(res.dangling).toEqual([])
  })

  it('collects dangling entries with prefix tags on a crafted-bad registry', () => {
    const res = validateRegistry(BAD_REGISTRY)
    expect(res.ok).toBe(false)
    expect(res.dangling).toContain('combo:fast-rr:nope/badmodel')
    expect(res.dangling).toContain('alias:opus:ghost/missing-model')
    expect(res.dangling).toContain('advisor:fast:void/also-missing')
  })
})

describe('ccbRouting bootstrapCCBRouting', () => {
  it('bootstraps ok with a catalog built from the real provider list', () => {
    const out = bootstrapCCBRouting()
    expect(out.ok).toBe(true)
    expect(out.dangling).toEqual([])
    const catalog = out.catalog as { providers: unknown[] }
    expect(catalog.providers.length).toBe(listProviders().length)
  })

  it('does not throw on a clean registry even with throwOnDangling', () => {
    expect(() => bootstrapCCBRouting({ throwOnDangling: true })).not.toThrow()
  })

  it('throws on dangling refs when throwOnDangling is set', () => {
    expect(() =>
      bootstrapCCBRouting({ throwOnDangling: true, registry: BAD_REGISTRY }),
    ).toThrow(/dangling references/)
  })

  it('resolveProvider returns undefined for a known-bad id (no false resolution)', () => {
    expect(resolveProvider('this-provider-does-not-exist')).toBeUndefined()
  })
})
