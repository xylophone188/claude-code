import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { rmSync } from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// mock.module is process-global and must be registered before
// sessionMemory.js is imported, so the module under test is loaded lazily.

// Fresh, not-yet-created directory per test: setupSessionMemoryFile() creates
// the directory and the summary file itself, which is what we want to verify
// the indexer reads back. The filesystem mock reads the current values.
let sessionMemoryDir = join(tmpdir(), 'claude-code-sm-wiring')
let sessionMemoryPath = join(sessionMemoryDir, 'summary.md')
let sessionMemoryDirCounter = 0

mock.module('bun:bundle', () => ({ feature: () => false }))

const actualState = await import('src/bootstrap/state.ts')
mock.module('src/bootstrap/state.ts', () => ({
  ...actualState,
  getIsRemoteMode: () => false,
  getSessionId: () => 'test-session-id-123',
}))

const actualLog = await import('src/utils/log.ts')
mock.module('src/utils/log.ts', () => ({
  ...actualLog,
  logError: () => {},
}))

const actualDebug = await import('src/utils/debug.ts')
mock.module('src/utils/debug.ts', () => ({
  ...actualDebug,
  logForDebugging: () => {},
}))

const actualErrors = await import('src/utils/errors.ts')
mock.module('src/utils/errors.ts', () => ({
  ...actualErrors,
  errorMessage: (e: unknown) => String(e),
  getErrnoCode: () => undefined,
}))

const actualFsOps = await import('src/utils/fsOperations.ts')
mock.module('src/utils/fsOperations.ts', () => ({
  ...actualFsOps,
  getFsImplementation: () => require('node:fs/promises'),
  safeResolvePath: (p: string) => p,
}))

const actualFsPerms = await import('src/utils/permissions/filesystem.ts')
mock.module('src/utils/permissions/filesystem.ts', () => ({
  ...actualFsPerms,
  getSessionMemoryDir: () => sessionMemoryDir + '/',
  getSessionMemoryPath: () => sessionMemoryPath,
}))

mock.module('src/utils/messages.ts', () => ({
  createUserMessage: ({ content }: { content: string }) => ({
    type: 'user',
    uuid: 'msg-1',
    message: { content: [{ type: 'text', text: content }] },
  }),
  hasToolCallsInLastAssistantTurn: () => false,
}))

mock.module('src/utils/tokens.ts', () => ({
  getTokenUsage: () => undefined,
  tokenCountWithEstimation: () => 100,
}))

mock.module('src/utils/systemPromptType.ts', () => ({
  asSystemPrompt: (p: unknown) => p,
}))

mock.module('src/context.ts', () => ({
  getUserContext: () => ({}),
  getSystemContext: () => ({}),
}))

mock.module('src/constants/prompts.ts', () => ({
  getSystemPrompt: async () => 'system prompt',
}))

mock.module('src/services/analytics/index.ts', () => ({ logEvent: () => {} }))

mock.module('src/services/analytics/growthbook.ts', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: (key: string, fallback: unknown) =>
    key === 'tengu_session_memory' ? true : (fallback ?? false),
  getDynamicConfig_CACHED_MAY_BE_STALE: () => ({}),
}))

mock.module('src/services/compact/autoCompact.ts', () => ({
  isAutoCompactEnabled: () => true,
}))

let registeredHooks: Array<(context: unknown) => unknown> = []
mock.module('src/utils/hooks/postSamplingHooks.ts', () => ({
  registerPostSamplingHook: (hook: unknown) => {
    registeredHooks.push(hook as (context: unknown) => unknown)
  },
  clearPostSamplingHooks: () => {
    registeredHooks.length = 0
  },
}))

mock.module('src/utils/forkedAgent.ts', () => ({
  runForkedAgent: () => Promise.resolve(),
  createCacheSafeParams: () => ({}),
  createSubagentContext: () => ({ readFileState: new Map() }),
}))

mock.module(
  '@claude-code-best/builtin-tools/tools/FileEditTool/constants.ts',
  () => ({ FILE_EDIT_TOOL_NAME: 'mock_edit' }),
)

mock.module(
  '@claude-code-best/builtin-tools/tools/FileReadTool/FileReadTool.ts',
  () => ({
    FileReadTool: {
      call: async () => ({
        data: { type: 'text', file: { content: '# Session Notes\n' } },
      }),
    },
  }),
)

mock.module('src/services/SessionMemory/sessionMemoryUtils.ts', () => ({
  DEFAULT_SESSION_MEMORY_CONFIG: {
    minimumMessageTokensToInit: 1,
    minimumTokensBetweenUpdate: 1,
    toolCallsBetweenUpdates: 1,
  },
  getSessionMemoryConfig: () => ({
    minimumMessageTokensToInit: 1,
    minimumTokensBetweenUpdate: 1,
    toolCallsBetweenUpdates: 1,
  }),
  getToolCallsBetweenUpdates: () => 1,
  hasMetInitializationThreshold: () => true,
  hasMetUpdateThreshold: () => true,
  isSessionMemoryInitialized: () => false,
  markSessionMemoryInitialized: () => {},
  markExtractionStarted: () => {},
  markExtractionCompleted: () => {},
  recordExtractionTokenCount: () => {},
  setSessionMemoryConfig: () => {},
  setLastSummarizedMessageId: () => {},
  getLastSummarizedMessageId: () => undefined,
  waitForSessionMemoryExtraction: () => Promise.resolve(),
}))

mock.module('src/services/SessionMemory/prompts.ts', () => ({
  buildSessionMemoryUpdatePrompt: async () => 'mock prompt',
  loadSessionMemoryTemplate: async () => '# Session Notes\n',
}))

const indexCalls: Array<Record<string, unknown>> = []
const ensureCalls: number[] = []
mock.module('src/services/searchEngine/sessionMemoryIndex.ts', () => ({
  SESSION_MEMORY_INDEX_NAME: 'session_memory',
  indexSessionMemory: async () => ({ ok: true }),
  indexSessionMemoryFireAndForget: (options: Record<string, unknown>) => {
    indexCalls.push(options)
    void Promise.resolve()
  },
  ensureSessionMemorySearchIndex: async () => {
    ensureCalls.push(Date.now())
  },
  ensureSessionMemoryIndex: async () => true,
  pingSearchEngine: async () => true,
  readSessionMemoryText: async () => null,
  resolveSessionMemoryDocId: () => 'test-session-id-123',
  resetSessionMemoryIndexState: () => {},
}))

let originalFlag: string | undefined

beforeEach(() => {
  originalFlag = process.env['CCB_SESSION_MEMORY_SEARCH_ENABLED']
  delete process.env['CCB_SESSION_MEMORY_SEARCH_ENABLED']
  indexCalls.length = 0
  ensureCalls.length = 0
  registeredHooks = []
})

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env['CCB_SESSION_MEMORY_SEARCH_ENABLED']
  } else {
    process.env['CCB_SESSION_MEMORY_SEARCH_ENABLED'] = originalFlag
  }
})

test('initSessionMemory registers the hook and warms up the ES/IK index', async () => {
  const { initSessionMemory } = await import('../sessionMemory.js')
  initSessionMemory()

  const hooks = registeredHooks
  expect(hooks.length).toBeGreaterThan(0)
  expect(typeof hooks[hooks.length - 1]).toBe('function')
  expect(ensureCalls).toHaveLength(1)
})

describe('extractSessionMemory mirrors the summary into Elasticsearch', () => {
  beforeEach(() => {
    sessionMemoryDirCounter += 1
    sessionMemoryDir = join(
      tmpdir(),
      `claude-code-sm-wiring-${process.pid}-${sessionMemoryDirCounter}`,
    )
    sessionMemoryPath = join(sessionMemoryDir, 'summary.md')
  })

  afterEach(() => {
    rmSync(sessionMemoryDir, { recursive: true, force: true })
  })

  test('fires off indexing with the memory path', async () => {
    const { initSessionMemory } = await import('../sessionMemory.js')
    registeredHooks = []
    initSessionMemory()
    const extractSessionMemory = registeredHooks[
      registeredHooks.length - 1
    ] as (context: unknown) => Promise<void>

    await extractSessionMemory({
      messages: [
        {
          type: 'user',
          uuid: 'msg-1',
          message: { content: [{ type: 'text', text: 'hello world' }] },
        },
      ],
      toolUseContext: { readFileState: new Map() },
      querySource: 'repl_main_thread',
    })

    expect(indexCalls).toEqual([{ memoryPath: sessionMemoryPath }])
  })

  test('never indexes from a non-main-thread query', async () => {
    const { initSessionMemory } = await import('../sessionMemory.js')
    registeredHooks = []
    initSessionMemory()
    const extractSessionMemory = registeredHooks[
      registeredHooks.length - 1
    ] as (context: unknown) => Promise<void>

    await extractSessionMemory({
      messages: [],
      toolUseContext: { readFileState: new Map() },
      querySource: 'sdk',
    })

    expect(indexCalls).toEqual([])
  })

  test('manual manuallyExtractSessionMemory mirrors the summary into Elasticsearch', async () => {
    const { manuallyExtractSessionMemory } = await import('../sessionMemory.js')
    const result = await manuallyExtractSessionMemory(
      [
        {
          type: 'user',
          uuid: '00000000-0000-0000-0000-000000000001',
          message: { content: [{ type: 'text', text: 'manual trigger' }] },
        },
      ],
      {
        readFileState: new Map(),
        options: {
          tools: [],
          mainLoopModel: 'claude-3-opus',
        },
      } as any,
    )

    expect(result.success).toBe(true)
    expect(indexCalls).toEqual([{ memoryPath: sessionMemoryPath }])
  })
})
