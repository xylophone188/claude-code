import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Shared mutable state accessed via closures in mock factories.
const state: {
  disk: string | null
  store: Record<string, string>
  calls: Array<{ op: string; key?: string; value?: string; ttl?: number }>
  redisFails: boolean
} = {
  disk: null,
  store: {},
  calls: [],
  redisFails: false,
}

function failIfDown() {
  if (state.redisFails) throw new Error('redis down')
}

mock.module('fs/promises', () => ({
  readFile: async () => {
    if (state.disk === null)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return state.disk
  },
}))
mock.module('node:fs/promises', () => ({
  readFile: async () => {
    if (state.disk === null)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return state.disk
  },
}))
mock.module('src/utils/permissions/filesystem.ts', () => ({
  getSessionMemoryPath: () => '/tmp/session-memory/summary.md',
}))
mock.module('src/utils/log.ts', () => ({ logError: () => {} }))
mock.module('src/utils/errors.ts', () => ({
  errorMessage: (e: unknown) => String(e),
}))
mock.module('src/services/redis/client.ts', () => ({
  redisGet: async (key: string) => {
    state.calls.push({ op: 'get', key })
    failIfDown()
    return state.store[key] ?? null
  },
  redisSet: async (key: string, value: string, ttl: number) => {
    state.calls.push({ op: 'set', key, value, ttl })
    failIfDown()
    state.store[key] = value
  },
  redisDel: async (key: string) => {
    state.calls.push({ op: 'del', key })
    failIfDown()
    delete state.store[key]
  },
  getRedisClient: () => null,
}))

process.env.CCB_SESSION_MEMORY_CACHE_ENABLED = '1'

const CACHE_MOD = await import(
  'src/services/searchEngine/sessionMemoryCache.js'
)

beforeEach(() => {
  state.disk = null
  state.store = {}
  state.calls = []
  state.redisFails = false
  process.env.CCB_SESSION_MEMORY_CACHE_ENABLED = '1'
})

describe('sessionMemoryCache', () => {
  test('getSessionMemoryCached returns Redis value on hit', async () => {
    const { createHash } = await import('crypto')
    const h = createHash('sha256')
      .update('/tmp/session-memory/summary.md')
      .digest('hex')
      .slice(0, 16)
    state.store['ccb:sm:mem:v1:' + h] = 'from-redis'
    const r = await CACHE_MOD.getSessionMemoryCached()
    expect(r).toBe('from-redis')
    expect(state.calls.some(c => c.op === 'get')).toBe(true)
    expect(state.calls.some(c => c.op === 'set')).toBe(false)
  })

  test('getSessionMemoryCached falls back to disk and backfills', async () => {
    state.disk = '# disk content'
    const r = await CACHE_MOD.getSessionMemoryCached()
    expect(r).toBe('# disk content')
    await new Promise(r2 => setTimeout(r2, 20))
    expect(
      state.calls.some(
        c => c.op === 'set' && c.value === '# disk content' && c.ttl === 30,
      ),
    ).toBe(true)
  })

  test('getSessionMemoryCached returns null when both sources empty', async () => {
    state.disk = null
    const r = await CACHE_MOD.getSessionMemoryCached()
    expect(r).toBeNull()
  })

  test('getSessionMemoryCached tolerates Redis failure and falls back to disk', async () => {
    state.redisFails = true
    state.disk = '# disk fallback'
    const r = await CACHE_MOD.getSessionMemoryCached()
    expect(r).toBe('# disk fallback')
  })

  test('getSessionMemoryFromRedis is no-op when cache disabled', async () => {
    process.env.CCB_SESSION_MEMORY_CACHE_ENABLED = '0'
    const r = await CACHE_MOD.getSessionMemoryFromRedis()
    expect(r).toBeNull()
    expect(state.calls.length).toBe(0)
  })

  test('getSessionMemoryCached is disk-only when cache disabled', async () => {
    process.env.CCB_SESSION_MEMORY_CACHE_ENABLED = '0'
    state.disk = '# disk only'
    const r = await CACHE_MOD.getSessionMemoryCached()
    expect(r).toBe('# disk only')
    // No Redis calls should have happened.
    expect(state.calls.length).toBe(0)
  })

  test('invalidateSessionMemoryCache calls redisDel when enabled', async () => {
    CACHE_MOD.invalidateSessionMemoryCache()
    await new Promise(r2 => setTimeout(r2, 20))
    expect(state.calls.some(c => c.op === 'del')).toBe(true)
  })

  test('invalidateSessionMemoryCache is no-op when disabled', async () => {
    process.env.CCB_SESSION_MEMORY_CACHE_ENABLED = '0'
    CACHE_MOD.invalidateSessionMemoryCache()
    await new Promise(r2 => setTimeout(r2, 20))
    expect(state.calls.length).toBe(0)
  })

  test('invalidateSessionMemoryCache swallows Redis failure', async () => {
    state.redisFails = true
    CACHE_MOD.invalidateSessionMemoryCache()
    await new Promise(r2 => setTimeout(r2, 20))
    // Should not throw; state.calls may or may not contain 'del' depending on error location.
    // The important invariant: no unhandled rejection.
  })
})
