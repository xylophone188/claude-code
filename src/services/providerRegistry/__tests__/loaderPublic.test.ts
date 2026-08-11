import { describe, it, expect } from 'bun:test'
import { BUILTIN_PROVIDERS, DEFAULT_PROVIDERS } from '../loader.js'
import { EMBEDDED_PROVIDERS } from '../embeddedProviders.generated.js'

describe('providerRegistry loader (stable public behavior)', () => {
  it('BUILTIN_PROVIDERS is a non-empty array', () => {
    expect(Array.isArray(BUILTIN_PROVIDERS)).toBe(true)
    expect(BUILTIN_PROVIDERS.length).toBeGreaterThan(0)
  })

  it('all BUILTIN_PROVIDERS ids are unique', () => {
    const ids = BUILTIN_PROVIDERS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every BUILTIN_PROVIDERS entry is well-formed', () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.kind).toBe('openai-compat')
      expect(p.id).toBeTruthy()
      expect(p.baseUrl.endsWith('/chat/completions')).toBe(false)
    }
  })

  it('EMBEDDED_PROVIDERS has a substantial set of providers', () => {
    expect(EMBEDDED_PROVIDERS.length).toBeGreaterThan(0)
    // Surface the actual count; do not hard-fail on exact value.
    console.log(`EMBEDDED_PROVIDERS.length = ${EMBEDDED_PROVIDERS.length}`)
    expect(EMBEDDED_PROVIDERS.length).toBeGreaterThanOrEqual(70)
  })

  it('DEFAULT_PROVIDERS ids are present in BUILTIN_PROVIDERS (defaults win dedup)', () => {
    const builtinIds = new Set(BUILTIN_PROVIDERS.map(p => p.id))
    for (const d of DEFAULT_PROVIDERS) {
      expect(builtinIds.has(d.id)).toBe(true)
    }
  })
})
