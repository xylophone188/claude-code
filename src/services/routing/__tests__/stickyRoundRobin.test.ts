import { describe, it, expect } from 'bun:test'
import { StickyRoundRobin, fromComboName } from '../stickyRoundRobin.js'

describe('StickyRoundRobin', () => {
  const MODELS = [
    'groq/llama-3.3-70b-versatile',
    'deepseek/deepseek-v4-pro',
    'openai/gpt-5.4',
  ]
  const combo = {
    name: 'fast-rr',
    strategy: 'sticky-round-robin' as const,
    stickyLimit: 3,
    models: MODELS,
  }

  it('stays sticky for stickyLimit calls then rotates', () => {
    const rr = new StickyRoundRobin(combo)
    // First 3 calls sticky on model 0.
    expect(rr.next()).toBe(MODELS[0])
    expect(rr.next()).toBe(MODELS[0])
    expect(rr.next()).toBe(MODELS[0])
    // Next 3 calls rotate to model 1.
    expect(rr.next()).toBe(MODELS[1])
    expect(rr.next()).toBe(MODELS[1])
    expect(rr.next()).toBe(MODELS[1])
    // Then model 2.
    expect(rr.next()).toBe(MODELS[2])
  })

  it('peek returns the current model without advancing attempt', () => {
    const rr = new StickyRoundRobin(combo)
    expect(rr.peek()).toBe(MODELS[0])
    expect(rr.attempt).toBe(0)
    expect(rr.peek()).toBe(MODELS[0])
    expect(rr.attempt).toBe(0)
    rr.next()
    expect(rr.attempt).toBe(1)
    expect(rr.peek()).toBe(MODELS[0])
  })

  it('fromComboName builds a selector for fast-rr', () => {
    const rr = fromComboName('fast-rr')
    expect(rr).toBeInstanceOf(StickyRoundRobin)
    expect(rr!.next()).toBe(MODELS[0])
    expect(rr!.attempt).toBe(1)
  })

  it('fromComboName returns undefined for non-sticky-round-robin combos', () => {
    expect(fromComboName('advisor-combo')).toBeUndefined()
    expect(fromComboName('nonexistent')).toBeUndefined()
  })
})
