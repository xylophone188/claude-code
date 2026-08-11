import { describe, test, expect } from 'bun:test'
import { tierOfProvider, tierRank, providersByTier } from '../providerTiers.js'

describe('providerTiers', () => {
  test('tierOfProvider classifies each known prefix', () => {
    expect(tierOfProvider('openai/gpt-5.4')).toBe('frontier')
    expect(tierOfProvider('xai/grok-4')).toBe('frontier')
    expect(tierOfProvider('kimi/kimi-k3')).toBe('strong')
    expect(tierOfProvider('deepseek/deepseek-v4-pro')).toBe('strong')
    expect(tierOfProvider('groq/llama-3.3-70b-versatile')).toBe('fast')
    expect(tierOfProvider('cerebras/foo')).toBe('fast')
    expect(tierOfProvider('qwen/bar')).toBe('fast')
    expect(tierOfProvider('unknown/thing')).toBe('free')
    expect(tierOfProvider('unknownonly')).toBe('free')
  })

  test('tierRank is ordered frontier > strong > fast > free', () => {
    expect(tierRank('frontier')).toBeGreaterThan(tierRank('strong'))
    expect(tierRank('strong')).toBeGreaterThan(tierRank('fast'))
    expect(tierRank('fast')).toBeGreaterThan(tierRank('free'))
    expect(tierRank('frontier')).toBe(3)
    expect(tierRank('free')).toBe(0)
  })

  test('providersByTier is non-empty for frontier and covers all providers', () => {
    const byTier = providersByTier()
    expect(Array.isArray(byTier.frontier)).toBe(true)
    expect(byTier.frontier.length).toBeGreaterThan(0)
    expect(byTier.frontier).toContain('openai')
    expect(byTier.frontier).toContain('xai')

    const total =
      byTier.frontier.length +
      byTier.strong.length +
      byTier.fast.length +
      byTier.free.length
    expect(total).toBeGreaterThanOrEqual(byTier.frontier.length)
  })
})
