import { describe, test, expect, mock, beforeEach } from 'bun:test'

const state: {
  available: boolean
  diskContent: string | null
  diskBytes: number
  executeCalls: Array<{ sql: string; params: unknown[] }>
  isAvailableCalls: number
  failAll: boolean
  failUpsert: boolean
  currentSessionId: string
} = {
  available: true,
  diskContent: '# mem',
  diskBytes: 100,
  executeCalls: [],
  isAvailableCalls: 0,
  failAll: false,
  failUpsert: false,
  currentSessionId: 'sess-test-123',
}

function isCreateTable(sql: string) {
  return sql.includes('CREATE TABLE')
}

mock.module('fs/promises', () => ({
  readFile: async () => {
    if (state.diskContent === null)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return state.diskContent
  },
  stat: async () => ({ size: state.diskBytes }),
}))
mock.module('node:fs/promises', () => ({
  readFile: async () => {
    if (state.diskContent === null)
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return state.diskContent
  },
  stat: async () => ({ size: state.diskBytes }),
}))
mock.module('src/bootstrap/state.ts', () => ({
  getSessionId: () => state.currentSessionId,
}))
mock.module('src/utils/permissions/filesystem.ts', () => ({
  getSessionMemoryPath: () => '/tmp/session-memory/summary.md',
}))
mock.module('src/utils/log.ts', () => ({ logError: () => {} }))
mock.module('src/utils/errors.ts', () => ({
  errorMessage: (e: unknown) => String(e),
}))
mock.module('src/services/pg/pool.ts', () => ({
  pgIsAvailable: async () => {
    state.isAvailableCalls++
    return state.available
  },
  pgExecute: async (sql: string, params: unknown[]) => {
    state.executeCalls.push({ sql, params })
    if (state.failAll) throw new Error('pg execute down')
    if (state.failUpsert && !isCreateTable(sql))
      throw new Error('pg upsert down')
  },
  pgQuery: async (sql: string, params: unknown[]) => {
    state.executeCalls.push({ sql, params })
    return [{ content: 'cached content' }]
  },
  getPgPool: () => null,
}))

beforeEach(() => {
  state.available = true
  state.diskContent = '# mem'
  state.diskBytes = 100
  state.executeCalls = []
  state.isAvailableCalls = 0
  state.failAll = false
  state.failUpsert = false
  state.currentSessionId = 'sess-test-123'
  process.env.CCB_SESSION_MEMORY_PG_ENABLED = '1'
})

const MOD = await import('src/services/searchEngine/sessionMemoryStore.js')

beforeEach(() => {
  MOD._resetSessionMemoryStoreForTests()
})

describe('sessionMemoryStore', () => {
  test('upsertSessionMemoryToPg creates table then upserts content', async () => {
    await MOD.upsertSessionMemoryToPg({
      content: '# content',
      memoryPath: '/tmp/session-memory/summary.md',
    })
    expect(state.executeCalls.length).toBe(2)
    expect(isCreateTable(state.executeCalls[0].sql)).toBe(true)
    expect(state.executeCalls[0].sql).toContain('omniroute.session_memory')
    expect(state.executeCalls[1].sql).toContain(
      'ON CONFLICT (session_id) DO UPDATE',
    )
    const params = state.executeCalls[1].params
    expect(params[0]).toBe('sess-test-123')
    expect(params[1]).toBe('# content')
    expect(params[2]).toBe('/tmp/session-memory/summary.md')
    expect(params[3]).toBe(100)
  })

  test('upsertSessionMemoryToPg is no-op when PG disabled', async () => {
    process.env.CCB_SESSION_MEMORY_PG_ENABLED = '0'
    await MOD.upsertSessionMemoryToPg({
      content: '# nope',
      memoryPath: '/tmp/x',
    })
    expect(state.executeCalls.length).toBe(0)
    expect(state.isAvailableCalls).toBe(0)
  })

  test('upsertSessionMemoryToPg swallows PG unavailability', async () => {
    state.available = false
    await MOD.upsertSessionMemoryToPg({
      content: '# nope',
      memoryPath: '/tmp/x',
    })
    expect(state.executeCalls.length).toBe(0)
  })

  test('upsertSessionMemoryToPg swallows CREATE TABLE failure', async () => {
    state.failAll = true
    await MOD.upsertSessionMemoryToPg({
      content: '# nope',
      memoryPath: '/tmp/x',
    })
    // Only the CREATE TABLE call was made; no UPSERT. No throw.
    expect(state.executeCalls.length).toBe(1)
    expect(isCreateTable(state.executeCalls[0].sql)).toBe(true)
  })

  test('upsertSessionMemoryToPg swallows UPSERT failure after successful CREATE TABLE', async () => {
    state.failUpsert = true
    await MOD.upsertSessionMemoryToPg({
      content: '# nope',
      memoryPath: '/tmp/x',
    })
    // CREATE TABLE succeeded, UPSERT failed. Both attempts recorded, no throw.
    expect(state.executeCalls.length).toBe(2)
    expect(isCreateTable(state.executeCalls[0].sql)).toBe(true)
    expect(isCreateTable(state.executeCalls[1].sql)).toBe(false)
  })

  test('getSessionMemoryFromPg returns content on hit', async () => {
    const r = await MOD.getSessionMemoryFromPg('sess-test-123')
    expect(r).toBe('cached content')
    expect(state.executeCalls.some(c => c.sql.includes('SELECT content'))).toBe(
      true,
    )
  })

  test('getSessionMemoryFromPg is no-op when PG disabled', async () => {
    process.env.CCB_SESSION_MEMORY_PG_ENABLED = '0'
    const r = await MOD.getSessionMemoryFromPg('sess-x')
    expect(r).toBeNull()
    expect(state.executeCalls.length).toBe(0)
  })

  test('getSessionMemoryFromPg returns null when PG unavailable', async () => {
    state.available = false
    const r = await MOD.getSessionMemoryFromPg('sess-x')
    expect(r).toBeNull()
  })

  test('upsertSessionMemoryToPg skips UPSERT when content is empty', async () => {
    state.diskContent = ''
    await MOD.upsertSessionMemoryToPg({ memoryPath: '/tmp/x' })
    const upsertCalls = state.executeCalls.filter(c => !isCreateTable(c.sql))
    expect(upsertCalls.length).toBe(0)
  })

  test('upsertSessionMemoryToPg reads content from disk when not provided', async () => {
    state.diskContent = '# from disk'
    state.diskBytes = 42
    await MOD.upsertSessionMemoryToPg({ memoryPath: '/tmp/x' })
    const upsert = state.executeCalls.find(c => !isCreateTable(c.sql))
    expect(upsert).toBeDefined()
    expect(upsert!.params[1]).toBe('# from disk')
    expect(upsert!.params[3]).toBe(42)
  })
})
