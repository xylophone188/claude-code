import { describe, it, expect, beforeEach } from 'bun:test'
import {
  admittedClasses,
  isAdmitted,
  rankQuotaCandidates,
  recordConsumption,
  resetQuotaGate,
  snapshotQuotaGate,
  updateRemaining,
  QUOTA_CLASSES,
} from '../quotaGate.js'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

beforeEach(() => {
  resetQuotaGate()
})

describe('isAdmitted', () => {
  it('always admits the race pool and the permanent tier', () => {
    for (const className of ['l1', 'l7'] as const) {
      const state = isAdmitted('nvidia/z-ai/glm-5.3', className, {}, NOW)
      expect(state.admitted).toBe(true)
      expect(state.exhausted).toBe(false)
    }
  })

  it('admits unknown classes by default (fail open)', () => {
    const state = isAdmitted('mystery/provider', 'l9', {}, NOW)
    expect(state.admitted).toBe(true)
    expect(state.className).toBe('l9')
  })

  it('rejects unknown classes when strict', () => {
    const state = isAdmitted('mystery/provider', 'l9', { lenient: false }, NOW)
    expect(state.admitted).toBe(false)
  })

  it('admits a fresh 5h window and rejects it once drained', () => {
    const fresh = isAdmitted('openai', 'l2', {}, NOW)
    expect(fresh.admitted).toBe(true)
    recordConsumption('openai', 'l2', 95, {}, NOW)
    const drained = isAdmitted('openai', 'l2', {}, NOW)
    expect(drained.admitted).toBe(false)
    expect(drained.remainingPercent).toBe(5)
    expect(drained.exhausted).toBe(true)
  })

  it('ingests upstream remaining via updateRemaining', () => {
    updateRemaining('openai', 'l2', 3, NOW + HOUR, {}, NOW)
    const state = isAdmitted('openai', 'l2', {}, NOW)
    expect(state.admitted).toBe(false)
    expect(state.exhausted).toBe(true)
    expect(snapshotQuotaGate().windows.openai?.l2).toBe(3)
  })

  it('refills the window once the reset time passes', () => {
    updateRemaining('openai', 'l2', 3, NOW + HOUR, {}, NOW)
    const afterReset = isAdmitted('openai', 'l2', {}, NOW + HOUR + 1)
    expect(afterReset.admitted).toBe(true)
    expect(afterReset.remainingPercent).toBe(100)
  })

  it('rationes l6 to the one-shot limit', () => {
    expect(isAdmitted('gemini', 'l6', {}, NOW).admitted).toBe(true)
    recordConsumption('gemini', 'l6', 1, {}, NOW)
    const drained = isAdmitted('gemini', 'l6', {}, NOW)
    expect(drained.admitted).toBe(false)
    expect(drained.exhausted).toBe(true)
  })
})

describe('admittedClasses', () => {
  it('reports the full chain when nothing is exhausted', () => {
    expect(admittedClasses('openai', {}, NOW)).toEqual([...QUOTA_CLASSES])
  })

  it('drops classes that are drained', () => {
    recordConsumption('openai', 'l2', 95, {}, NOW)
    recordConsumption('openai', 'l6', 1, {}, NOW)
    const classes = admittedClasses('openai', {}, NOW)
    expect(classes).not.toContain('l2')
    expect(classes).not.toContain('l6')
    expect(classes).toContain('l1')
    expect(classes).toContain('l7')
  })
})

describe('rankQuotaCandidates', () => {
  it('defers the permanent tier until the pool is exhausted', () => {
    const ranked = rankQuotaCandidates(
      [
        { provider: 'openai', className: 'l7' },
        { provider: 'github', className: 'l7' },
        { provider: 'nvidia/z-ai/glm-5.3', className: 'l1' },
      ],
      {},
      NOW,
    )
    expect(ranked[0].provider).toBe('nvidia/z-ai/glm-5.3')
    expect(ranked[ranked.length - 1].provider).toBe('github')
  })

  it('drops exhausted classes below healthy ones', () => {
    recordConsumption('openai', 'l2', 95, {}, NOW)
    const ranked = rankQuotaCandidates(
      [
        { provider: 'openai', className: 'l2' },
        { provider: 'github', className: 'l3' },
      ],
      {},
      NOW,
    )
    expect(ranked[0].provider).toBe('github')
  })

  it('fronts an l6 credential whose deadline is imminent', () => {
    const ranked = rankQuotaCandidates(
      [
        { provider: 'openai', className: 'l5' },
        { provider: 'gemini', className: 'l6', expiresAt: NOW + HOUR },
        { provider: 'github', className: 'l1' },
      ],
      {},
      NOW,
      24 * HOUR,
    )
    expect(ranked[0].provider).toBe('gemini')
  })
})

describe('recordConsumption', () => {
  it('ignores l1 and l7 consumption', () => {
    recordConsumption('nvidia/z-ai/glm-5.3', 'l1', 50, {}, NOW)
    recordConsumption('ollama/llama3.1', 'l7', 50, {}, NOW)
    expect(snapshotQuotaGate()).toEqual({
      windows: {},
      exhausted: {},
      consumedOnce: {},
    })
  })
})
