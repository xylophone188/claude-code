import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  calculateFactors,
  calculateScore,
  DEFAULT_WEIGHTS,
  getAutoCandidateTiers,
  scorePoolSync,
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

describe('getAutoCandidateTiers', () => {
  const candidates = process.env.CCB_AUTO_CANDIDATES

  afterEach(() => {
    if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
    else process.env.CCB_AUTO_CANDIDATES = candidates
  })

  it('treats environment candidates as L1 only', () => {
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    expect(getAutoCandidateTiers()).toEqual({
      l1: ['opencode/deepseek-v4-flash-free'],
      l2: [],
      l3: [],
      l4: [],
      l5: [],
      l6: [],
    })
  })

  it('keeps a non-empty L2 pool when no env override exists', () => {
    delete process.env.CCB_AUTO_CANDIDATES
    const l2 = getAutoCandidateTiers().l2
    expect(l2.length).toBeGreaterThan(0)
    // Present in both the built-in default and the deployed auto-candidates.json.
    expect(l2).toContain('nvidia/z-ai/glm-5.2')
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

  it('uses recent race outcomes to break equal-score candidates', () => {
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
      'fast/model',
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

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('shares concurrent refreshes', async () => {
    const candidates = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
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
