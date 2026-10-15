import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import {
  SESSION_MEMORY_INDEX_NAME,
  ensureSessionMemoryIndex,
  indexSessionMemory,
  indexSessionMemoryFireAndForget,
  pingSearchEngine,
  readSessionMemoryText,
  resolveSessionMemoryDocId,
  resetSessionMemoryIndexState,
} from './sessionMemoryIndex.js'
import type { SearchEngineClient } from './client.js'

type MockCall = { path: string; method?: string; body?: string }

function paths(calls: MockCall[]): string[] {
  return calls.map(call => call.path)
}

/**
 * Builds a fake SearchEngineClient that records every ES path it was asked to
 * talk to. `reachable=false` mimics a down cluster (connection refused, DNS
 * failure, timeout) by rejecting every request.
 */
function makeMockClient(
  opts: {
    reachable?: boolean
    ikFails?: boolean
    indexFails?: boolean
    indexDocFails?: boolean
    calls?: MockCall[]
  } = {},
): { client: SearchEngineClient; calls: MockCall[] } {
  const reachable = opts.reachable ?? true
  const calls = opts.calls ?? []
  const record = (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method, body: init?.body })
  }
  const fail = () => {
    throw new Error('ES connection refused')
  }
  return {
    calls,
    client: {
      ping: async () => {
        record('/')
        if (!reachable) fail()
        return true
      },
      createIndexWithIK: async (index: string) => {
        record(`/${index}`, { method: 'PUT' })
        if (!reachable) fail()
        if (opts.ikFails) fail()
      },
      createIndex: async (index: string) => {
        record(`/${index}`, { method: 'PUT' })
        if (!reachable) fail()
        if (opts.indexFails) fail()
      },
      indexDocument: async (
        index: string,
        docId: string,
        document: Record<string, unknown>,
      ) => {
        record(`/${index}/_doc/${docId}`, {
          method: 'PUT',
          body: JSON.stringify(document),
        })
        if (!reachable) fail()
        if (opts.indexDocFails) fail()
        return { ok: true }
      },
    } as unknown as SearchEngineClient,
  }
}

let disabledEnvWasSet: boolean
let tmpDir: string | undefined

function freshMemoryFile(content: string): string {
  tmpDir ??= mkdtempSync(join(tmpdir(), 'sm-index-test-'))
  const memoryPath = join(
    tmpDir,
    `memory-${Math.random().toString(36).slice(2)}.md`,
  )
  writeFileSync(memoryPath, content, 'utf8')
  return memoryPath
}

beforeAll(() => {
  disabledEnvWasSet = 'CCB_SESSION_MEMORY_SEARCH_ENABLED' in process.env
  delete process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED
})

afterAll(() => {
  if (disabledEnvWasSet) {
    process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED = '1'
  } else {
    delete process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  resetSessionMemoryIndexState()
  delete process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED
})

describe('graceful degradation when Elasticsearch is unavailable', () => {
  test('unreachable ES never throws and never creates an index or document', async () => {
    const { client, calls } = makeMockClient({ reachable: false })

    expect(await indexSessionMemory({ client })).toEqual({
      ok: false,
      reason: 'unreachable',
    })
    // Only the liveness probe: nothing was written to the cluster.
    expect(paths(calls)).toEqual(['/'])
  })

  test('pingSearchEngine converts a rejected probe into false, not a throw', async () => {
    const { client } = makeMockClient({ reachable: false })
    expect(await pingSearchEngine(client)).toBe(false)
  })

  test('indexDocument failure degrades to { ok: false, reason: "error" }', async () => {
    const memoryPath = freshMemoryFile('content that failed to index\n')
    const { client } = makeMockClient({ indexDocFails: true })

    expect(await indexSessionMemory({ client, memoryPath })).toEqual({
      ok: false,
      reason: 'error',
    })
  })

  test('opt-out flag short-circuits before touching the network', async () => {
    process.env.CCB_SESSION_MEMORY_SEARCH_ENABLED = '0'
    const { client, calls } = makeMockClient()

    expect(await indexSessionMemory({ client })).toEqual({
      ok: false,
      reason: 'disabled',
    })
    expect(calls).toEqual([])
  })

  test('missing or empty memory file is a no-op (no index, no document)', async () => {
    const { client, calls } = makeMockClient()
    const missingPath = join(tmpdir(), 'claude-no-such-session-memory.md')

    expect(
      await indexSessionMemory({ client, memoryPath: missingPath }),
    ).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(
      await indexSessionMemory({
        client,
        memoryPath: freshMemoryFile('   \n\n'),
      }),
    ).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(paths(calls)).toEqual(['/', '/'])
  })
})

describe('IK indexing', () => {
  test('creates the IK index and writes one document keyed by the session id', async () => {
    const memoryPath = freshMemoryFile('# Session\nRemember to ship the fix\n')
    const { client, calls } = makeMockClient()

    expect(await indexSessionMemory({ client, memoryPath })).toEqual({
      ok: true,
    })
    expect(paths(calls)).toEqual([
      '/',
      `/${SESSION_MEMORY_INDEX_NAME}`,
      `/${SESSION_MEMORY_INDEX_NAME}/_doc/${getSessionId()}`,
    ])

    const doc = JSON.parse(calls[2]!.body!) as {
      session_id: string
      text: string
      updated_at: string
    }
    expect(doc.text).toContain('Remember to ship the fix')
    expect(doc.session_id).toBe(getSessionId())
    expect(typeof doc.updated_at).toBe('string')
  })

  test('falls back to the default analyzer when the IK plugin is missing', async () => {
    const memoryPath = freshMemoryFile('fallback content\n')
    const { client, calls } = makeMockClient({ ikFails: true })

    expect(await indexSessionMemory({ client, memoryPath })).toEqual({
      ok: true,
    })
    expect(paths(calls)).toEqual([
      '/',
      `/${SESSION_MEMORY_INDEX_NAME}`, // createIndexWithIK (fails)
      `/${SESSION_MEMORY_INDEX_NAME}`, // createIndex fallback
      `/${SESSION_MEMORY_INDEX_NAME}/_doc/${getSessionId()}`,
    ])
  })

  test('oversized documents are refused without touching the cluster', async () => {
    const memoryPath = freshMemoryFile('x'.repeat(300))
    const { client, calls } = makeMockClient()

    expect(
      await indexSessionMemory({ client, memoryPath, maxBytes: 100 }),
    ).toEqual({ ok: false, reason: 'empty' })
    expect(paths(calls)).toEqual(['/'])
  })

  test('fire-and-forget wrapper never throws synchronously when ES is down', () => {
    const { client } = makeMockClient({ reachable: false })
    expect(() => void indexSessionMemoryFireAndForget({ client })).not.toThrow()
  })
})

describe('ensureSessionMemoryIndex', () => {
  test('memoizes index creation for the life of the process (no retry storm)', async () => {
    const { client, calls } = makeMockClient()
    expect(await ensureSessionMemoryIndex(client)).toBe(true)
    expect(await ensureSessionMemoryIndex(client)).toBe(true)
    expect(paths(calls)).toEqual([`/${SESSION_MEMORY_INDEX_NAME}`])
  })

  test('a failed creation stays failed and does not throw', async () => {
    const { client } = makeMockClient({ ikFails: true, indexFails: true })
    expect(await ensureSessionMemoryIndex(client)).toBe(false)
    expect(await ensureSessionMemoryIndex(client)).toBe(false)
  })
})

describe('helpers', () => {
  test('resolveSessionMemoryDocId follows the bootstrap session id', () => {
    expect(resolveSessionMemoryDocId()).toBe(getSessionId())
  })

  test('readSessionMemoryText only returns readable, non-blank content', () => {
    const filled = freshMemoryFile('# Notes\ncontent here\n')
    return readSessionMemoryText(filled).then(content => {
      expect(content).toContain('content here')
    })
  })
})
