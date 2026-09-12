import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  compressMessagesForProvider,
  getContextCompressionBudgetTokens,
  getRemoteCompressionUrl,
  isContextCompressionEnabled,
  isContextCompressionSkippedWhenOmniRoute,
} from '../runtime.js'

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

beforeEach(() => {
  mock.module('src/utils/config.ts', () => ({
    getGlobalConfig: () => ({}),
  }))
})

afterEach(() => {
  process.env = { ...originalEnv }
  globalThis.fetch = originalFetch
})

describe('context compression runtime configuration', () => {
  it('uses config defaults when no environment override is present', () => {
    delete process.env.CCB_CONTEXT_COMPRESSION_ENABLED
    delete process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS
    delete process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE
    delete process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL
    expect(isContextCompressionEnabled()).toBe(true)
    expect(getContextCompressionBudgetTokens()).toBe(24000)
    expect(isContextCompressionSkippedWhenOmniRoute()).toBe(true)
    expect(getRemoteCompressionUrl()).toBeUndefined()
  })

  it('allows environment values to override config defaults', () => {
    process.env.CCB_CONTEXT_COMPRESSION_ENABLED = '0'
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '123'
    process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE = 'false'
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
    expect(isContextCompressionEnabled()).toBe(false)
    expect(getContextCompressionBudgetTokens()).toBe(123)
    expect(isContextCompressionSkippedWhenOmniRoute()).toBe(false)
    expect(getRemoteCompressionUrl()).toBe('https://example.com/c')
  })

  it('rejects non-http(s) remote URL schemes', () => {
    delete process.env.CCB_CONTEXT_COMPRESSION_ENABLED
    delete process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS
    delete process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'file:///etc/passwd'
    expect(getRemoteCompressionUrl()).toBeUndefined()
  })

  it('rejects invalid remote URL strings', () => {
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'not a url'
    expect(getRemoteCompressionUrl()).toBeUndefined()
  })

  it('rejects non-numeric budget tokens', () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = 'abc'
    expect(getContextCompressionBudgetTokens()).toBe(0)
  })

  it('accepts valid numeric budget tokens', () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '500'
    expect(getContextCompressionBudgetTokens()).toBe(500)
  })

  it('lets environment overrides win when global config is unavailable', () => {
    mock.module('src/utils/config.ts', () => ({
      getGlobalConfig: () => {
        throw new Error('config not initialized')
      },
    }))
    process.env.CCB_CONTEXT_COMPRESSION_ENABLED = '0'
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '7'
    process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE = 'false'
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
    expect(isContextCompressionEnabled()).toBe(false)
    expect(getContextCompressionBudgetTokens()).toBe(7)
    expect(isContextCompressionSkippedWhenOmniRoute()).toBe(false)
    expect(getRemoteCompressionUrl()).toBe('https://example.com/c')
  })

  it('falls back to defaults when global config is unavailable and env is unset', () => {
    mock.module('src/utils/config.ts', () => ({
      getGlobalConfig: () => {
        throw new Error('config not initialized')
      },
    }))
    delete process.env.CCB_CONTEXT_COMPRESSION_ENABLED
    delete process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS
    delete process.env.CCB_CONTEXT_COMPRESSION_SKIP_WHEN_OMNIROUTE
    delete process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL
    expect(isContextCompressionEnabled()).toBe(true)
    expect(getContextCompressionBudgetTokens()).toBe(24000)
    expect(isContextCompressionSkippedWhenOmniRoute()).toBe(true)
    expect(getRemoteCompressionUrl()).toBeUndefined()
  })
})

describe('compressMessagesForProvider', () => {
  const messages = [
    { type: 'user' as const, message: { content: 'old '.repeat(100) } },
    { type: 'assistant' as const, message: { content: 'new' } },
  ]

  it('returns disabled source when compression is disabled', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_ENABLED = '0'
    const result = await compressMessagesForProvider(messages, ['anthropic'])
    expect(result.source).toBe('disabled')
    expect(result.messages).toEqual(messages)
  })

  it('skips routes owned by OmniRoute', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    const result = await compressMessagesForProvider(messages, ['omniroute'])
    expect(result.source).toBe('omniroute')
    expect(result.messages).toEqual(messages)
  })

  it('skips routes owned by OmniRoute-9router', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    const result = await compressMessagesForProvider(messages, [
      'omniroute-9router',
    ])
    expect(result.source).toBe('omniroute')
    expect(result.messages).toEqual(messages)
  })

  it('keeps the newest message when the local budget is exceeded', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    const result = await compressMessagesForProvider(messages, ['anthropic'])
    expect(result.source).toBe('local')
    expect(result.messages).toEqual([messages[1]])
  })

  it('retains both sides of a tool transaction when trimming', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    const toolUse = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
      },
    }
    const toolResult = {
      type: 'user' as const,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
        ],
      },
    }
    const result = await compressMessagesForProvider(
      [
        { type: 'user' as const, message: { content: 'old '.repeat(100) } },
        toolUse,
        toolResult,
      ],
      ['anthropic'],
    )

    expect(result.source).toBe('local')
    expect(result.messages).toEqual([toolUse, toolResult])
    expect(result.messages).toHaveLength(2)
  })

  it('retains multiple tool transactions without orphaning either side', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    const firstUse = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
      },
    }
    const firstResult = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '1' }],
      },
    }
    const secondUse = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }],
      },
    }
    const secondResult = {
      type: 'user' as const,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: '2' }],
      },
    }
    const result = await compressMessagesForProvider(
      [firstUse, firstResult, secondUse, secondResult],
      ['anthropic'],
    )

    expect(result.messages).toEqual([secondUse, secondResult])
  })

  it('returns unchanged when budget is zero or negative', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '0'
    const result = await compressMessagesForProvider(messages, ['anthropic'])
    expect(result.source).toBe('unchanged')
    expect(result.messages).toEqual(messages)
  })

  it('falls back to local compression when remote URL fails', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
    mock.module('bun:network', () => ({}))
    globalThis.fetch = (async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch
    const result = await compressMessagesForProvider(messages, ['anthropic'])
    expect(result.source).toBe('local')
    expect(result.messages).toEqual([messages[1]])
    expect(result.remoteError).toBeInstanceOf(Error)
  })

  it('returns unchanged when remote fails and budget is zero', async () => {
    process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '0'
    process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
    globalThis.fetch = (async () => {
      throw new Error('network error')
    }) as unknown as typeof fetch
    const result = await compressMessagesForProvider(messages, ['anthropic'])
    expect(result.source).toBe('unchanged')
    expect(result.messages).toEqual(messages)
    expect(result.remoteError).toBeInstanceOf(Error)
  })

  describe('remote compression boundary handling', () => {
    const compressed = [
      { type: 'assistant' as const, message: { content: 'compressed' } },
    ]

    function okResponse(payload: unknown, headers?: Record<string, string>) {
      return new Response(JSON.stringify(payload), { headers })
    }

    it('uses the remote response when it succeeds', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({ messages: compressed })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('remote')
      expect(result.messages).toEqual(compressed)
      expect(result.remoteError).toBeUndefined()
    })

    it('falls back to local when the remote returns a non-ok status', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        new Response('boom', { status: 500 })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.messages).toEqual([messages[1]])
      expect(result.remoteError?.message).toMatch(/500/)
    })

    it('sends a request with an abort signal so a hang cannot block the turn', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      let seenSignal: unknown
      globalThis.fetch = (async (
        _url: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        seenSignal = init?.signal
        throw new Error('aborted')
      }) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(seenSignal).toBeInstanceOf(AbortSignal)
    })

    it('falls back when the request is aborted by the timeout', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        Promise.reject(
          new DOMException('aborted', 'AbortError'),
        )) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.messages).toEqual([messages[1]])
      expect(result.remoteError).toBeInstanceOf(Error)
    })

    it('falls back when content-length exceeds the response cap', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse(
          { messages: compressed },
          { 'content-length': String(10 * 1024 * 1024) },
        )) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/too large/)
    })

    it('falls back when the response body exceeds the byte cap', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        new Response('x'.repeat(5 * 1024 * 1024))) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/too large/)
    })

    it('falls back when the remote returns a non-object payload', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse('nope')) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/invalid messages/)
    })

    it('falls back when the remote messages are not an array', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({
          messages: { type: 'assistant' },
        })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/invalid messages/)
    })

    it('falls back when a remote message lacks the message field', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({
          messages: [{ type: 'assistant' }],
        })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/invalid messages/)
    })

    it('falls back when a remote message lacks the content field', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({
          messages: [{ type: 'assistant', message: {} }],
        })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/invalid messages/)
    })

    it('falls back when a remote message has a bad type field', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({
          messages: [{ type: 'robot', message: { content: 'x' } }],
        })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/invalid messages/)
    })

    it('falls back when the remote returns orphaned tool results', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      globalThis.fetch = (async () =>
        okResponse({
          messages: [
            {
              type: 'user',
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: 'ghost', content: 'x' },
                ],
              },
            },
          ],
        })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('local')
      expect(result.remoteError?.message).toMatch(/unpaired tool messages/)
    })

    it('preserves unknown fields on messages returned by the remote', async () => {
      process.env.CCB_CONTEXT_COMPRESSION_BUDGET_TOKENS = '1'
      process.env.CCB_CONTEXT_COMPRESSION_REMOTE_URL = 'https://example.com/c'
      const rich = {
        type: 'assistant' as const,
        message: { content: 'compressed' },
        customField: { nested: true },
      }
      globalThis.fetch = (async () =>
        okResponse({ messages: [rich] })) as unknown as typeof fetch
      const result = await compressMessagesForProvider(messages, ['anthropic'])
      expect(result.source).toBe('remote')
      expect(result.messages).toEqual([rich])
    })
  })
})
