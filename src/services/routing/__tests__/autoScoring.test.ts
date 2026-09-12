import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  calculateFactors,
  calculateScore,
  currentFreeOpenCodeModels,
  DEFAULT_WEIGHTS,
  getAutoCandidateTiers,
  refreshSenseNovaCatalog,
  resetSenseNovaCatalogForTests,
  scorePoolSync,
  writeOpenCodeModelsCache,
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
  const candidatesFile = process.env.CCB_AUTO_CANDIDATES_FILE

  afterEach(() => {
    if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
    else process.env.CCB_AUTO_CANDIDATES = candidates
    if (candidatesFile === undefined)
      delete process.env.CCB_AUTO_CANDIDATES_FILE
    else process.env.CCB_AUTO_CANDIDATES_FILE = candidatesFile
  })

  it('treats environment candidates as L1 only', () => {
    // Isolate the deployed auto-candidates.json: the env branch is the unit
    // under test, not whatever a real machine happens to have configured.
    process.env.CCB_AUTO_CANDIDATES_FILE = '/nonexistent-ccb-auto.json'
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    expect(getAutoCandidateTiers()).toEqual({
      l1: ['opencode/deepseek-v4-flash-free'],
      l2: [],
      l3: [],
      l4: [],
      l5: [],
      l6: [],
      l7: [],
    })
  })

<<<<<<< Updated upstream
<<<<<<< Updated upstream
  it('keeps a non-empty L2 pool when no env override or config file exists', () => {
    delete process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES_FILE = '/nonexistent-ccb-auto.json'
    const l2 = getAutoCandidateTiers().l2
    expect(l2.length).toBeGreaterThan(0)
    expect(l2).toContain('nvidia/z-ai/glm-5.2')
=======
  it('keeps a non-empty candidate pool when no env override exists', () => {
    delete process.env.CCB_AUTO_CANDIDATES
=======
  it('keeps a non-empty candidate pool when no env override exists', () => {
    delete process.env.CCB_AUTO_CANDIDATES
>>>>>>> Stashed changes
    const tiers = getAutoCandidateTiers()
    const pool = [...tiers.l1, ...tiers.l2]
    expect(pool.length).toBeGreaterThan(0)
    expect(pool.every(candidate => !candidate.startsWith('gitee/'))).toBe(true)
<<<<<<< Updated upstream
>>>>>>> Stashed changes
  })

  it('merges a synced SenseNova catalog into the L2 pool', async () => {
    delete process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES_FILE = '/nonexistent-ccb-auto.json'
    const previousUrl = process.env.CCB_SENSENOVA_MODELS_URL
    process.env.CCB_SENSENOVA_MODELS_URL = 'https://sensenova.example/v1/models'
    resetSenseNovaCatalogForTests()
    try {
      await refreshSenseNovaCatalog(
        (async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'glm-5.2' },
                { id: 'sensenova-6.8-flash-lite' },
                { id: 'glm-5.2-pro' },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      )

      const l2 = getAutoCandidateTiers().l2
      expect(l2).toEqual([
        'sensenova/glm-5.2',
        'sensenova/sensenova-6.8-flash-lite',
        'sensenova/glm-5.2-pro',
        'sensenova/deepseek-v4-flash',
        'nvidia/z-ai/glm-5.2',
      ])
    } finally {
      if (previousUrl === undefined) delete process.env.CCB_SENSENOVA_MODELS_URL
      else process.env.CCB_SENSENOVA_MODELS_URL = previousUrl
      resetSenseNovaCatalogForTests()
    }
=======
>>>>>>> Stashed changes
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

  it('omits gitee from every generation candidate pool and ranking', () => {
    const candidates = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES =
      'gitee/model,opencode/deepseek-v4-flash-free'
    try {
      const tiers = getAutoCandidateTiers()
      const pool = [
        ...tiers.l1,
        ...tiers.l2,
        ...tiers.l3,
        ...tiers.l4,
        ...tiers.l5,
        ...tiers.l6,
      ]
      expect(pool).not.toContain('gitee/model')
      expect(pool.every(candidate => !candidate.startsWith('gitee/'))).toBe(
        true,
      )
      const ranked = scorePoolSync([
        'gitee/model',
        'opencode/deepseek-v4-flash-free',
      ])
      expect(ranked.every(entry => !entry.candidate.startsWith('gitee/'))).toBe(
        true,
      )
    } finally {
      if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = candidates
    }
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
      expect(await refreshAutoHealth()).toBeUndefined()
    } finally {
      if (candidates === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = candidates
    }
  })
})

describe('OpenCode free-model cache', () => {
  const hour = 60 * 60 * 1000
  const baseTime = Date.parse('2026-09-06T12:00:00Z')
  const cacheDate = (offsetMs: number) =>
    new Date(baseTime + offsetMs).toISOString()
  const previousCacheFile = process.env.CCB_OPENCODE_MODELS_CACHE_FILE

  beforeEach(() => {
    process.env.CCB_OPENCODE_MODELS_CACHE_FILE = join(
      dir,
      'opencode-free-models.json',
    )
  })

  afterEach(() => {
    if (previousCacheFile === undefined)
      delete process.env.CCB_OPENCODE_MODELS_CACHE_FILE
    else process.env.CCB_OPENCODE_MODELS_CACHE_FILE = previousCacheFile
  })

  it('serves fresh cache inside the 8-hour window', () => {
    writeOpenCodeModelsCache({
      updatedAt: cacheDate(0),
      models: ['mimo-v2.5-free'],
    })
    const realNow = Date.now
    Date.now = () => baseTime + 7 * hour
    try {
      expect(currentFreeOpenCodeModels()).toEqual(['mimo-v2.5-free'])
    } finally {
      Date.now = realNow
    }
  })

  it('rejects an expired cache past the 8-hour window', () => {
    writeOpenCodeModelsCache({
      updatedAt: cacheDate(0),
      models: ['mimo-v2.5-free'],
    })
    const realNow = Date.now
    Date.now = () => baseTime + 8 * hour
    try {
      expect(currentFreeOpenCodeModels()).toEqual([])
    } finally {
      Date.now = realNow
    }
  })

  it('rejects a future-dated cache (clock skew)', () => {
    writeOpenCodeModelsCache({
      updatedAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      models: ['mimo-v2.5-free'],
    })
    expect(currentFreeOpenCodeModels()).toEqual([])
  })

  it('rejects a corrupted cache file', () => {
    writeFileSync(process.env.CCB_OPENCODE_MODELS_CACHE_FILE!, '{not json')
    expect(currentFreeOpenCodeModels()).toEqual([])
  })

  it('rejects an empty models array', () => {
    writeOpenCodeModelsCache({
      updatedAt: cacheDate(0),
      models: [],
    })
    expect(currentFreeOpenCodeModels()).toEqual([])
  })

  it('never falls back to a hardcoded legacy model', () => {
    expect(currentFreeOpenCodeModels()).not.toContain('deepseek-v4-flash-free')
  })
})
