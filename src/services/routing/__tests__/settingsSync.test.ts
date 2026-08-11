import { describe, it, expect } from 'bun:test'
import {
  collectSettings,
  syncSettings,
  diffSettings,
  type CCBRoutingSettings,
  type Transport,
} from '../settingsSync.js'

describe('ccbRouting settingsSync', () => {
  it('collectSettings returns the expected shape', () => {
    const s = collectSettings()
    expect(Array.isArray(s.combos)).toBe(true)
    expect(Array.isArray(s.aliases)).toBe(true)
    expect(Array.isArray(s.advisorTiers)).toBe(true)
    expect(typeof s.generatedAt).toBe('number')
    expect(s.combos.length).toBeGreaterThan(0)
    expect(s.aliases.length).toBeGreaterThan(0)
    expect(s.advisorTiers.length).toBeGreaterThan(0)
  })

  it('syncSettings calls the injected transport with a payload', async () => {
    const received: CCBRoutingSettings[] = []
    const transport: Transport = async payload => {
      received.push(payload)
    }
    await syncSettings(transport)
    expect(received.length).toBe(1)
    expect(Array.isArray(received[0].combos)).toBe(true)
    expect(received[0].generatedAt).toBeGreaterThan(0)
  })

  it('syncSettings uses the provided snapshot when given', async () => {
    const transport: Transport = async () => {}
    const snapshot: CCBRoutingSettings = {
      combos: [{ name: 'x' }],
      aliases: [{ alias: 'y', target: 'x' }],
      advisorTiers: [{ name: 't', models: ['openai/gpt-5.4'] }],
      generatedAt: 123,
    }
    let captured: CCBRoutingSettings | undefined
    await syncSettings(async p => {
      captured = p
    }, snapshot)
    expect(captured).toBe(snapshot)
    expect(transport).toBeDefined()
  })

  it('diffSettings detects changed top-level keys', () => {
    const a = collectSettings()
    const b: CCBRoutingSettings = {
      ...a,
      combos: [...a.combos, { name: 'new' }],
    }
    const changed = diffSettings(a, b)
    expect(changed).toContain('combos')
    expect(changed).not.toContain('aliases')
  })

  it('diffSettings returns empty when snapshots are identical', () => {
    const a = collectSettings()
    const b: CCBRoutingSettings = JSON.parse(JSON.stringify(a))
    expect(diffSettings(a, b)).toEqual([])
  })
})
