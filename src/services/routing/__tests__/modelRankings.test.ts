import { describe, it, expect } from 'bun:test'
import {
  defaultRankings,
  loadRankings,
  rankForIntent,
  topModel,
  type Rankings,
} from '../modelRankings.js'

describe('modelRankings', () => {
  it('defaultRankings is well-ordered by score desc and uses only real ids', () => {
    const r = defaultRankings()
    expect(r.models.length).toBe(5)
    const scores = r.models.map(m => m.score)
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
    }
    // top tier (frontier) must be first and carry the highest score.
    expect(r.models[0].id).toBe('openai/gpt-5.4')
    expect(r.models[0].tier).toBe('frontier')
  })

  it('loadRankings returns defaults when no fetcher is given', async () => {
    const r = await loadRankings()
    expect(r.models[0].id).toBe('openai/gpt-5.4')
  })

  it('loadRankings calls the injected fetcher (no network in tests)', async () => {
    const injected: Rankings = {
      updatedAt: 123,
      models: [{ id: 'xai/grok-4', score: 99, tier: 'frontier' }],
    }
    const r = await loadRankings(async () => injected)
    expect(r).toBe(injected)
    expect(r.updatedAt).toBe(123)
  })

  it('rankForIntent filters to the mapped tier and stays sorted', () => {
    const r = defaultRankings()
    const advisory = rankForIntent(r, 'advisory')
    expect(advisory.length).toBe(2)
    expect(advisory.every(m => m.tier === 'frontier')).toBe(true)

    const work = rankForIntent(r, 'work')
    expect(work.length).toBe(1)
    expect(work[0].id).toBe('groq/llama-3.3-70b-versatile')
    expect(work.every(m => m.tier === 'fast')).toBe(true)
  })

  it('topModel returns the highest-ranked id, optionally scoped by intent', () => {
    const r = defaultRankings()
    expect(topModel(r)).toBe('openai/gpt-5.4')
    expect(topModel(r, 'advisory')).toBe('openai/gpt-5.4')
    expect(topModel(r, 'work')).toBe('groq/llama-3.3-70b-versatile')
  })
})
