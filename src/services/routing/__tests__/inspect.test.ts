import { describe, it, expect } from 'bun:test'
import { inspectSpec } from '../inspect.js'

describe('inspectSpec', () => {
  it('inspects a provider/model spec', () => {
    const r = inspectSpec('kimi/kimi-k3')
    expect(r.resolved).toBe(true)
    expect(r.kind).toBe('provider')
    expect(r.providerId).toBe('kimi')
    expect(r.model).toBe('kimi-k3')
    expect(r.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(r.apiKeyEnv).toBe('CCB_KIMI_KEY')
  })

  it('inspects an alias spec', () => {
    const r = inspectSpec('opus')
    expect(r.resolved).toBe(true)
    expect(r.kind).toBe('alias')
    expect(r.providerId).toBe('openai')
    expect(r.notes.some(n => n.includes('alias'))).toBe(true)
  })

  it('inspects a combo name', () => {
    const r = inspectSpec('fast-rr')
    expect(r.resolved).toBe(true)
    expect(r.kind).toBe('combo')
    expect(r.comboStrategy).toBe('sticky-round-robin')
    expect(r.providerId).toBe('groq') // first model in the combo
    expect(r.baseUrl).toBe('https://api.groq.com/openai/v1')
  })

  it('inspects the advisor virtual model', () => {
    const r = inspectSpec('advisor')
    expect(r.resolved).toBe(true)
    expect(r.kind).toBe('advisor')
    expect(r.tier).toBe('frontier')
    expect(r.providerId).toBe('openai')
    expect(r.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('returns resolved=false for an unknown spec', () => {
    const r = inspectSpec('totally-unknown-model-xyz')
    expect(r.resolved).toBe(false)
    expect(r.kind).toBeUndefined()
    expect(r.notes.length).toBeGreaterThan(0)
  })
})
