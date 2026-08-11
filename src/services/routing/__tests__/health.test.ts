import { describe, it, expect } from 'bun:test'
import type { CCBRoutingProvider } from '../types.js'
import {
  type Probe,
  type HealthResult,
  defaultTcpProbe,
  checkProviderHealth,
  checkAll,
} from '../health.js'
import { listProviders } from '../resolve.js'

function fakeProvider(
  id: string,
  baseUrl = 'http://localhost:1234',
): CCBRoutingProvider {
  return { id, kind: 'openai-compat', baseUrl, defaultModel: 'x' }
}

describe('health', () => {
  it('checkProviderHealth uses injected probe on success', async () => {
    const okProbe: Probe = async p => ({ ok: true, latencyMs: 7 })
    const res = await checkProviderHealth(
      fakeProvider('openai/gpt-4o'),
      okProbe,
    )
    expect(res.ok).toBe(true)
    expect(res.latencyMs).toBe(7)
  })

  it('checkProviderHealth surfaces failure via injected probe', async () => {
    const failProbe: Probe = async p => ({ ok: false, error: 'boom' })
    const res = await checkProviderHealth(fakeProvider('bad/id'), failProbe)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })

  it('checkProviderHealth falls back to defaultTcpProbe when none injected', async () => {
    // defaultTcpProbe won't actually connect in this env; it must still return a HealthResult shape.
    const res = await checkProviderHealth(fakeProvider('openai/gpt-4o'))
    expect(typeof res.ok).toBe('boolean')
    expect(res).toHaveProperty('ok')
  })

  it('checkAll aggregates per-provider results keyed by id', async () => {
    const providers = [fakeProvider('a/x'), fakeProvider('b/y')]
    const probe: Probe = async p =>
      p.id === 'a/x' ? { ok: true, latencyMs: 1 } : { ok: false, error: 'down' }
    const out = await checkAll(probe, providers)
    expect(Object.keys(out).sort()).toEqual(['a/x', 'b/y'])
    expect(out['a/x'].ok).toBe(true)
    expect(out['b/y'].ok).toBe(false)
  })

  it('checkAll uses resolve.listProviders() ids when no list given', async () => {
    const real = listProviders()
    const known = real.map(p => p.id)
    const probe: Probe = async () => ({ ok: true })
    const out = await checkAll(probe)
    expect(Object.keys(out).length).toBe(known.length)
    for (const id of known) expect(out[id]).toBeDefined()
  })

  it('defaultTcpProbe parses host:port and returns a HealthResult on error', async () => {
    // Connect to a closed port -> error path, still a well-formed result.
    const res = await defaultTcpProbe(fakeProvider('c/z', 'http://127.0.0.1:1'))
    expect(typeof res.ok).toBe('boolean')
  })
})
