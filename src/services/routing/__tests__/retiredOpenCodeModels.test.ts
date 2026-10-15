import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

// opencode/deepseek-v4-flash-free is no longer free. It must never re-enter the
// routing candidate pool — not as an active_pool member, not as a fallback.
// These tests prove the retirement gate holds on every entry path: a stale
// cache file, an explicit CCB_AUTO_CANDIDATES env value, and a bare name.
const RETIRED = 'deepseek-v4-flash-free'

// autoScoring resolves its cache path from $HOME at module-eval time, and Bun
// caches homedir() — so point the cache at a temp file via the documented env
// override BEFORE the first import.
const dir = mkdtempSync(join(tmpdir(), 'ccb-retired-opencode-'))
mkdirSync(join(dir, '.ccb-embed'))
const cacheFile = join(dir, '.ccb-embed', 'opencode-free-models.json')
const originalCacheEnv = process.env.CCB_OPENCODE_MODELS_CACHE_FILE
process.env.CCB_OPENCODE_MODELS_CACHE_FILE = cacheFile
rmSync(cacheFile, { force: true })

const FRESH_WITH_RETIRED = {
  updatedAt: new Date().toISOString(),
  models: [RETIRED, 'space-bunny-free'],
}
const STALE_WITH_RETIRED = {
  updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
  models: [RETIRED, 'space-bunny-free'],
}
const FRESH_ONLY_RETIRED = {
  updatedAt: new Date().toISOString(),
  models: [RETIRED],
}

const {
  currentFreeOpenCodeModels,
  filterOpenCodeCandidates,
  filterRetiredOpenCodeModels,
  getAutoCandidates,
} = await import('../autoScoring.js')

afterEach(() => {
  delete process.env.CCB_AUTO_CANDIDATES
  delete process.env.OPENCODE_FREE_MODEL
})

describe('retired opencode models are excluded from the candidate pool', () => {
  test('drops the model from the cache list itself', () => {
    expect(filterRetiredOpenCodeModels([RETIRED])).toEqual([])
    expect(filterRetiredOpenCodeModels([RETIRED, 'space-bunny-free'])).toEqual([
      'space-bunny-free',
    ])
  })

  test('drops it from candidate specs in every spelling', () => {
    expect(filterOpenCodeCandidates([`opencode/${RETIRED}`])).toEqual([])
    expect(filterOpenCodeCandidates([RETIRED])).toEqual([])
    expect(
      filterOpenCodeCandidates([`opencode/${RETIRED}`, 'nvidia/*']),
    ).toEqual(['nvidia/*'])
    expect(
      filterOpenCodeCandidates([
        `opencode/${RETIRED}`,
        `opencode/space-bunny-free`,
        'nvidia/*',
      ]),
    ).toEqual(['opencode/space-bunny-free', 'nvidia/*'])
  })

  test('survives the reported case: opencode/* wildcard with a stale cache', () => {
    // This is exactly the pool the user saw logged: opencode/* + nvidia/*.
    writeFileSync(cacheFile, JSON.stringify(FRESH_WITH_RETIRED))
    process.env.CCB_AUTO_CANDIDATES = 'opencode/*,nvidia/*'
    const pool = getAutoCandidates()
    expect(pool.some(candidate => candidate.includes(RETIRED))).toBe(false)
    expect(pool).toContain('opencode/space-bunny-free')
  })

  test('never appears in the default active_pool', () => {
    writeFileSync(cacheFile, JSON.stringify(FRESH_WITH_RETIRED))
    const pool = getAutoCandidates()
    expect(pool.some(candidate => candidate.includes(RETIRED))).toBe(false)
    expect(pool).toContain('opencode/space-bunny-free')
  })

  test('drops it from a stale cache too', () => {
    writeFileSync(cacheFile, JSON.stringify(STALE_WITH_RETIRED))
    expect(currentFreeOpenCodeModels()).toEqual([])
  })

  test('omits it when the cache holds nothing but the retired model', () => {
    writeFileSync(cacheFile, JSON.stringify(FRESH_ONLY_RETIRED))
    expect(currentFreeOpenCodeModels()).toEqual([])
    process.env.CCB_AUTO_CANDIDATES = 'opencode/*'
    expect(getAutoCandidates()).toEqual([])
  })

  test('omits the retired model when there is no cache at all', () => {
    rmSync(cacheFile, { force: true })
    expect(currentFreeOpenCodeModels()).toEqual([])
    process.env.CCB_AUTO_CANDIDATES = 'opencode/*'
    expect(getAutoCandidates()).toEqual([])
  })

  test('drops an explicit env candidate naming the retired model', () => {
    rmSync(cacheFile, { force: true })
    process.env.CCB_AUTO_CANDIDATES = `opencode/${RETIRED},nvidia/*`
    expect(getAutoCandidates()).toEqual(['nvidia/*'])
  })

  test('drops an explicit env candidate using the bare retired name', () => {
    rmSync(cacheFile, { force: true })
    process.env.CCB_AUTO_CANDIDATES = `${RETIRED},space-bunny-free`
    expect(getAutoCandidates()).toEqual(['space-bunny-free'])
  })
})

// Restore env and remove the temp dir once, at process exit: bun runs the
// file-scoped cleanup after every test, which would delete the cache dir the
// next test is about to write.
process.on('exit', () => {
  if (originalCacheEnv === undefined)
    delete process.env.CCB_OPENCODE_MODELS_CACHE_FILE
  else process.env.CCB_OPENCODE_MODELS_CACHE_FILE = originalCacheEnv
  rmSync(dir, { recursive: true, force: true })
})
