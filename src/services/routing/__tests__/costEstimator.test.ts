import { describe, it, expect } from 'bun:test'
import { estimateCost, priceFor, PRICING } from '../costEstimator.js'

describe('ccbRouting costEstimator', () => {
  it('priceFor returns nominal rates for a known id', () => {
    expect(priceFor('openai/gpt-5.4')).toEqual({ in: 5, out: 15 })
    expect(priceFor('kimi/kimi-k3')).toEqual({ in: 1, out: 3 })
  })

  it('priceFor returns zero for an unknown id', () => {
    expect(priceFor('no-such-model')).toEqual({ in: 0, out: 0 })
  })

  it('estimateCost computes known-id cost math correctly', () => {
    const r = estimateCost('openai/gpt-5.4', 1_000_000, 1_000_000)
    expect(r.inputCost).toBe(5)
    expect(r.outputCost).toBe(15)
    expect(r.total).toBe(20)
    expect(r.currency).toBe('USD')
  })

  it('estimateCost scales with token counts', () => {
    const r = estimateCost('xai/grok-4', 500_000, 1_000_000)
    expect(r.inputCost).toBe(2.5) // 5/1e6 * 500k
    expect(r.outputCost).toBe(15) // 15/1e6 * 1e6
    expect(r.total).toBe(17.5)
  })

  it('estimateCost via spec resolves to a known id', () => {
    const r = estimateCost('groq/llama-3.3-70b-versatile', 2_000_000, 1_000_000)
    expect(r.model).toBe('groq/llama-3.3-70b-versatile')
    expect(r.inputCost).toBeCloseTo(0.4, 6) // 0.2/1e6 * 2e6
    expect(r.outputCost).toBeCloseTo(0.2, 6)
    expect(r.total).toBeCloseTo(0.6, 6)
  })

  it('estimateCost treats unknown spec as zero cost', () => {
    const r = estimateCost('mystery/unknown-model', 1_000_000, 1_000_000)
    expect(r.inputCost).toBe(0)
    expect(r.outputCost).toBe(0)
    expect(r.total).toBe(0)
    expect(r.model).toBe('mystery/unknown-model')
  })
})
