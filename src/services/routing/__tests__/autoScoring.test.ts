import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  calculateFactors,
  calculateScore,
  DEFAULT_WEIGHTS,
  getAutoCandidates,
  getAutoCandidateTiers,
  scorePoolSync,
  scorePoolDynamic,
  subscriptionTimeValue,
} from '../autoScoring.js'
import { fetchCodeBuddyQuota } from '../usage/codebuddy.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autoScoring-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('calculateFactors', () => {
  it('maps quota percentage to a 0..1 factor', () => {
    expect(calculateFactors(1, 0.5, 0).quota).toBe(0)
    expect(calculateFactors(1, 0.5, 40).quota).toBe(0.4)
    expect(calculateFactors(1, 0.5, 100).quota).toBe(1)
  })

  it('treats missing quota as neutral 1', () => {
    expect(calculateFactors(1, 0.5, undefined).quota).toBe(1)
  })

  it('drops the score as quota drains', () => {
    const full = calculateScore(calculateFactors(1, 0.5, 100), DEFAULT_WEIGHTS)
    const empty = calculateScore(calculateFactors(1, 0.5, 0), DEFAULT_WEIGHTS)
    expect(empty).toBeLessThan(full)
  })
})

describe('getAutoCandidates', () => {
  const candidates = process.env.CCB_AUTO_CANDIDATES

  afterEach(() => {
    if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
    else process.env.CCB_AUTO_CANDIDATES = candidates
  })

  it('resolves unified candidate pool without static tier debt', () => {
    delete process.env.CCB_AUTO_CANDIDATES
    const pool = getAutoCandidates()
    expect(pool.length).toBeGreaterThan(0)
    expect(pool).toContain('nvidia/*')
      })

  it('supports explicit environment candidate override', () => {
    process.env.CCB_AUTO_CANDIDATES = 'opencode/gemini-3.8-flash'
    expect(getAutoCandidates()).toEqual(['opencode/gemini-3.8-flash'])
  })
})

describe('scorePoolSync', () => {
  const metricsFile = () => join(dir, 'race-metrics.jsonl')
  const previousMetricsFile = process.env.CCB_RACE_METRICS_FILE

  afterEach(() => {
    if (previousMetricsFile === undefined)
      delete process.env.CCB_RACE_METRICS_FILE
    else process.env.CCB_RACE_METRICS_FILE = previousMetricsFile
  })

  it('keeps configured order when race learning is delegated to OmniRoute', () => {
    process.env.CCB_RACE_METRICS_FILE = metricsFile()
    writeFileSync(
      metricsFile(),
      [
        {
          provider: 'fast',
          model: 'model',
          outcome: 'selected',
          elapsedMs: 50,
          ttftMs: 50,
        },
        {
          provider: 'slow',
          model: 'model',
          outcome: 'failed',
          elapsedMs: 5000,
        },
      ]
        .map(metric => JSON.stringify(metric))
        .join('\n'),
    )
    expect(scorePoolSync(['slow/model', 'fast/model'])[0]?.candidate).toBe(
      'slow/model',
    )
  })
})

describe('fetchCodeBuddyQuota', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function mockFetchJson(body: unknown, status = 200) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch
  }

  it('computes the refill pack remaining percentage', async () => {
    const cycleEnd = Date.parse('2026-09-01T00:00:00Z')
    mockFetchJson({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                CycleEndTime: '2026-09-01T00:00:00Z',
                DeductionEndTime: cycleEnd + 3 * 86400000,
                CycleCapacitySizePrecise: 100,
                CycleCapacityUsedPrecise: 25,
              },
            ],
          },
        },
      },
    })
    expect(await fetchCodeBuddyQuota('https://quota', 'sk-cb-1')).toBe(75)
  })

  it('returns undefined when only one-shot bonus packs exist', async () => {
    const cycleEnd = Date.parse('2026-09-01T00:00:00Z')
    mockFetchJson({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: [
              {
                CycleEndTime: '2026-09-01T00:00:00Z',
                DeductionEndTime: cycleEnd + 86400000, // gap < 2 days → bonus
                CycleCapacitySizePrecise: 10,
              },
            ],
          },
        },
      },
    })
    expect(
      await fetchCodeBuddyQuota('https://quota', 'sk-cb-1'),
    ).toBeUndefined()
  })

  it('returns undefined on 401 and on code !== 0', async () => {
    mockFetchJson({ code: 401 }, 401)
    expect(
      await fetchCodeBuddyQuota('https://quota', 'sk-cb-1'),
    ).toBeUndefined()
    mockFetchJson({ code: 1, data: {} })
    expect(
      await fetchCodeBuddyQuota('https://quota', 'sk-cb-1'),
    ).toBeUndefined()
  })
})

describe('refreshAutoHealth', () => {
  const realFetch = globalThis.fetch
  const routingMode = process.env.OMNIROUTE_SERVER_ROUTING

  beforeEach(() => {
    process.env.OMNIROUTE_SERVER_ROUTING = '0'
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (routingMode === undefined) delete process.env.OMNIROUTE_SERVER_ROUTING
    else process.env.OMNIROUTE_SERVER_ROUTING = routingMode
  })

  it('shares concurrent refreshes', async () => {
    const candidates = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'opencode/gemini-3.8-flash'
    let calls = 0
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('opencode.ai')) calls++
      await new Promise(resolve => setTimeout(resolve, 10))
      return new Response('{}')
    }) as unknown as typeof fetch
    try {
      const { refreshAutoHealth } = await import(
        `../autoScoring.js?dedupe=${Date.now()}`
      )
      await Promise.all([refreshAutoHealth(), refreshAutoHealth()])
      expect(calls).toBe(1)
    } finally {
      if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = candidates
    }
  })

  it('keeps the probe refresh alive when one CodeBuddy quota probe fails', async () => {
    const candidates = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'codebuddy-cn/hy3-preview'
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('billing/meter')) throw new Error('offline')
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch
    try {
      const { refreshAutoHealth } = await import(
        `../autoScoring.js?quota-failure=${Date.now()}`
      )
      await expect(refreshAutoHealth()).resolves.toBeUndefined()
    } finally {
      if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = candidates
    }
  })
})

describe('subscriptionTimeValue', () => {
  it('returns 0 for non-subscription models', () => {
    expect(subscriptionTimeValue('nvidia/z-ai/glm-5.3', 0.9)).toBe(0)
    expect(subscriptionTimeValue('opencode/gemini-3.8-flash', 1)).toBe(0)
  })

  it('returns 0 for subscription models below healthy threshold', () => {
    expect(subscriptionTimeValue('agy/3.8-flash', 0.3)).toBe(0)
    expect(subscriptionTimeValue('codex/5.6-luna', 0.5)).toBe(0)
  })

  it('returns positive value for healthy subscription models', () => {
    expect(subscriptionTimeValue('agy/3.8-flash', 0.8)).toBeGreaterThan(0)
    expect(subscriptionTimeValue('codex/5.6-luna', 1)).toBeCloseTo(1, 6)
  })

  it('grows monotonically with health above threshold', () => {
    const low = subscriptionTimeValue('agy/3.8-flash', 0.7)
    const high = subscriptionTimeValue('agy/3.8-flash', 0.9)
    expect(high).toBeGreaterThan(low)
  })
})

describe('scorePoolDynamic', () => {
  it('returns empty list for empty candidates', async () => {
    const ranked = await scorePoolDynamic([])
    expect(ranked).toEqual([])
  })

  it('returns ranked candidates even when PG/Redis are unreachable', async () => {
    // No PG/Redis available in tests → degrade to neutral, still returns ranked
    const ranked = await scorePoolDynamic([
      'opencode/gemini-3.8-flash',
      'nvidia/z-ai/glm-5.3',
    ])
    expect(ranked.length).toBe(2)
    expect(ranked.every(r => typeof r.score === 'number')).toBe(true)
  })
})
