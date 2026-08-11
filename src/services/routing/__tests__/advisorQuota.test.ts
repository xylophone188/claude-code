import { describe, it, expect } from 'bun:test'
import { AdvisorQuota } from '../advisorQuota.js'
import { DEFAULT_ADVISOR_TIERS } from '../advisor.js'

describe('AdvisorQuota', () => {
  it("rotates round-robin across a tier's models in order", () => {
    const q = new AdvisorQuota()
    const frontier = DEFAULT_ADVISOR_TIERS[0].models
    expect(q.next('frontier')).toBe(frontier[0])
    expect(q.next('frontier')).toBe(frontier[1])
    expect(q.next('frontier')).toBe(frontier[0])
  })

  it('skips a model marked unhealthy/failed', () => {
    const q = new AdvisorQuota()
    const frontier = DEFAULT_ADVISOR_TIERS[0].models
    q.recordFailure(frontier[0])
    // first healthy model is picked instead of the failed one
    expect(q.next('frontier')).toBe(frontier[1])
    // once it's the only option, both marked -> empty
    q.recordFailure(frontier[1])
    expect(q.next('frontier')).toBe('')
  })

  it('tracks per-model usage via markUsed and usage()', () => {
    const q = new AdvisorQuota()
    const frontier = DEFAULT_ADVISOR_TIERS[0].models
    q.markUsed(frontier[0])
    q.markUsed(frontier[0])
    q.markUsed(frontier[1])
    const u = q.usage()
    expect(u[frontier[0]]).toBe(2)
    expect(u[frontier[1]]).toBe(1)
  })

  it('skips models that reached the hourly quota target', () => {
    const q = new AdvisorQuota({ quotaTargetPerHour: 2 })
    const frontier = DEFAULT_ADVISOR_TIERS[0].models
    q.markUsed(frontier[0])
    q.markUsed(frontier[0]) // now at quota
    expect(q.next('frontier')).toBe(frontier[1])
  })

  it('reset() clears all counters and unhealthy flags', () => {
    const q = new AdvisorQuota()
    const frontier = DEFAULT_ADVISOR_TIERS[0].models
    q.markUsed(frontier[0])
    q.recordFailure(frontier[1])
    q.reset()
    expect(q.usage()).toEqual({})
    // after reset the previously failed model is available again
    expect(q.next('frontier')).toBe(frontier[0])
  })
})
