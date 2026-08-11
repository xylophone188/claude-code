import { describe, expect, test } from 'bun:test'
import {
  buildResponsesRequest,
  chatCompletionsToResponses,
  createChatGPTResponsesStream,
  extractUsage,
  isChatGPTAccountQuotaExhausted,
  repairUTF8Mojibake,
} from '../responsesAdapter.js'
import { importChatGPTAuthFiles, removeChatGPTAuth } from '../chatgptAuth.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formatOpenAIPromptCacheKey } from '../openaiShared.js'
import { calculateCacheHitRate } from '../../../../utils/cacheWarning.js'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'

describe('buildResponsesRequest', () => {
  const promptCacheKey = formatOpenAIPromptCacheKey('session-abc-123')

  test('includes max reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'max',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'max' })
  })

  test('includes reasoning effort for ChatGPT Responses requests', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      reasoningEffort: 'xhigh',
      promptCacheKey,
    })

    expect(request.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('does not include unsupported max_output_tokens parameter', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    }) as Record<string, unknown>

    expect('max_output_tokens' in request).toBe(false)
  })

  test('includes stable prompt_cache_key for session-sticky cache routing', () => {
    const request = buildResponsesRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey,
    })

    expect(request.prompt_cache_key).toBe('ccb:session-abc-123')
  })

  test('prompt_cache_key is stable across turns (not derived from messages)', () => {
    const key = formatOpenAIPromptCacheKey('same-session')
    const turn1 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'first' }],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })
    const turn2 = buildResponsesRequest({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
      tools: [],
      toolChoice: undefined,
      promptCacheKey: key,
    })

    expect(turn1.prompt_cache_key).toBe(turn2.prompt_cache_key)
    expect(turn1.prompt_cache_key).toBe('ccb:same-session')
  })
})

describe('extractUsage (OpenAI Responses → Anthropic usage)', () => {
  test('subtracts cached_tokens so hit rate uses OpenAI total as denominator', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 20_000 },
      },
    })

    expect(usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 20_000,
    })

    // Was 40% under the double-count bug; correct is 66.7%.
    const hitRate = calculateCacheHitRate(usage)
    expect(hitRate).toBeCloseTo((20_000 / 30_000) * 100, 5)
  })

  test('full cache hit can report 100% (not capped at 50%)', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 30_000,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30_000 },
      },
    })

    expect(usage.input_tokens).toBe(0)
    expect(usage.cache_read_input_tokens).toBe(30_000)
    expect(calculateCacheHitRate(usage)).toBe(100)
  })

  test('maps cache_write_tokens to cache_creation without double-counting total', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 10_000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 6_000,
          cache_write_tokens: 2_000,
        },
      },
    })

    expect(usage).toEqual({
      input_tokens: 2_000,
      output_tokens: 10,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 6_000,
    })
    // segments sum to OpenAI total
    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(10_000)
    expect(calculateCacheHitRate(usage)).toBeCloseTo(60, 5)
  })

  test('clamps overlapping write/read that exceed total input', () => {
    const usage = extractUsage({
      usage: {
        input_tokens: 5_000,
        output_tokens: 0,
        input_tokens_details: {
          cached_tokens: 4_000,
          cache_write_tokens: 4_000,
        },
      },
    })

    expect(
      usage.input_tokens +
        usage.cache_creation_input_tokens +
        usage.cache_read_input_tokens,
    ).toBe(5_000)
    expect(usage.cache_read_input_tokens).toBe(4_000)
    expect(usage.cache_creation_input_tokens).toBe(1_000)
    expect(usage.input_tokens).toBe(0)
  })
})

describe('isChatGPTAccountQuotaExhausted', () => {
  test('only rotates on an explicit subscription quota signal', () => {
    expect(
      isChatGPTAccountQuotaExhausted(429, 'weekly usage limit reached'),
    ).toBe(true)
    expect(
      isChatGPTAccountQuotaExhausted(429, '{"code":"usage_limit_reached"}'),
    ).toBe(true)
    expect(isChatGPTAccountQuotaExhausted(429, 'rate limit exceeded')).toBe(
      false,
    )
  })
})

test('repairs CJK UTF-8 mojibake without changing normal text', () => {
  expect(repairUTF8Mojibake('è¯·æ±éè¯¯')).toBe('请求错误')
  expect(repairUTF8Mojibake('résumé')).toBe('résumé')
})

test('adapts direct fallback text stream to Responses events', async () => {
  const source = {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [{ delta: { content: 'PONG' }, finish_reason: null }],
      } as ChatCompletionChunk
      yield {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      } as ChatCompletionChunk
    },
  }
  expect(await Array.fromAsync(chatCompletionsToResponses(source))).toEqual([
    { type: 'response.output_text.delta', delta: 'PONG' },
    { type: 'response.completed', response: { status: 'completed' } },
  ])
})

test('falls through after every account reports subscription quota exhaustion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-pool-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const account = (id: string) => {
    const token = `x.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: id },
      }),
    ).toString('base64url')}.x`
    return JSON.stringify({
      tokens: { id_token: token, access_token: token, refresh_token: id },
    })
  }
  try {
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    await writeFile(first, account('sse-first'))
    await writeFile(second, account('sse-second'))
    await importChatGPTAuthFiles([first, second])
    let calls = 0
    const stream = await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async (url: string | URL | Request) => {
        if (String(url).includes('/wham/usage')) {
          return new Response(JSON.stringify({ rate_limit: {} }))
        }
        calls++
        return new Response('{"code":"usage_limit_reached"}', { status: 429 })
      }) as unknown as typeof fetch,
      onAccountExhausted: () => ({
        async *[Symbol.asyncIterator]() {
          yield { fallback: true }
        },
      }),
    })
    expect(await Array.fromAsync(stream)).toEqual([{ fallback: true }])
    expect(calls).toBe(2)
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})

test('rotates after a quota failure sent inside a successful SSE response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-sse-pool-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const account = (id: string) => {
    const token = `x.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: id },
      }),
    ).toString('base64url')}.x`
    return JSON.stringify({
      tokens: { id_token: token, access_token: token, refresh_token: id },
    })
  }
  try {
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    await writeFile(first, account('first'))
    await writeFile(second, account('second'))
    await importChatGPTAuthFiles([first, second])
    let calls = 0
    const stream = await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async (url: string | URL | Request) => {
        if (String(url).includes('/wham/usage')) {
          return new Response(JSON.stringify({ rate_limit: {} }))
        }
        calls++
        return new Response(
          'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n',
        )
      }) as unknown as typeof fetch,
      onAccountExhausted: () => ({
        async *[Symbol.asyncIterator]() {
          yield { fallback: true }
        },
      }),
    })
    expect(await Array.fromAsync(stream)).toEqual([{ fallback: true }])
    expect(calls).toBe(2)
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})

test('locks an account when SSE reports subscription quota after output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-sse-partial-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const account = (id: string) => {
    const token = `x.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: id },
      }),
    ).toString('base64url')}.x`
    return JSON.stringify({
      tokens: { id_token: token, access_token: token, refresh_token: id },
    })
  }
  try {
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    await writeFile(first, account('partial-first'))
    await writeFile(second, account('partial-second'))
    await importChatGPTAuthFiles([first, second])
    const calls: string[] = []
    const fetchOverride = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(url).includes('/wham/usage')) {
        return new Response(JSON.stringify({ rate_limit: {} }))
      }
      const accountId = new Headers(init?.headers).get('ChatGPT-Account-Id')
      calls.push(accountId ?? '')
      return accountId === 'partial-first'
        ? new Response(
            'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n',
          )
        : new Response(
            'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          )
    }) as typeof fetch
    const request = () =>
      buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      })

    await expect(
      Array.fromAsync(
        createChatGPTResponsesStream({
          request: request(),
          signal: new AbortController().signal,
          fetchOverride,
        }),
      ),
    ).rejects.toThrow('ChatGPT subscription quota exhausted')
    expect(calls).toEqual(['partial-first'])
    const quota = JSON.parse(
      await readFile(join(directory, 'openai-chatgpt-quota.json'), 'utf8'),
    ) as { accounts: Record<string, unknown> }
    expect(quota.accounts['partial-first']).toBeDefined()

    const stream = createChatGPTResponsesStream({
      request: request(),
      signal: new AbortController().signal,
      fetchOverride,
    })
    expect(await Array.fromAsync(stream)).toEqual([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])
    expect(calls).toEqual(['partial-first', 'partial-second'])
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})

test('rotates after a transport failure before falling through', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-error-pool-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const account = (id: string) => {
    const token = `x.${Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: id },
      }),
    ).toString('base64url')}.x`
    return JSON.stringify({
      tokens: { id_token: token, access_token: token, refresh_token: id },
    })
  }
  try {
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    await writeFile(first, account('transport-first'))
    await writeFile(second, account('transport-second'))
    await importChatGPTAuthFiles([first, second])
    let calls = 0
    const stream = await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async () => {
        calls++
        if (calls === 1) throw new TypeError('network down')
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        )
      }) as unknown as typeof fetch,
    })
    expect(await Array.fromAsync(stream)).toEqual([
      { type: 'response.output_text.delta', delta: 'ok' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])
    expect(calls).toBe(2)
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps a slow Responses stream alive after its first chunk', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-timeout-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  const timeout = process.env.CHATGPT_RESPONSES_TIMEOUT_MS
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CHATGPT_RESPONSES_TIMEOUT_MS = '300'
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'slow-stream' },
    }),
  ).toString('base64url')}.x`
  try {
    const auth = join(directory, 'account.json')
    await writeFile(
      auth,
      JSON.stringify({
        tokens: { id_token: token, access_token: token, refresh_token: 'slow' },
      }),
    )
    await importChatGPTAuthFiles([auth])
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
        )
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"o"}\n\n',
            ),
          )
        }, 50)
        setTimeout(() => {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"k"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ),
          )
          controller.close()
        }, 100)
      },
    })
    const stream = await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async () =>
        new Response(body)) as unknown as typeof fetch,
    })
    expect(await Array.fromAsync(stream)).toEqual([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'o' },
      { type: 'response.output_text.delta', delta: 'k' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    if (timeout === undefined) delete process.env.CHATGPT_RESPONSES_TIMEOUT_MS
    else process.env.CHATGPT_RESPONSES_TIMEOUT_MS = timeout
    await rm(directory, { recursive: true, force: true })
  }
})

test('falls through when Responses sends no chunk before the idle timeout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-idle-timeout-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  const timeout = process.env.CHATGPT_RESPONSES_TIMEOUT_MS
  process.env.CLAUDE_CONFIG_DIR = directory
  process.env.CHATGPT_RESPONSES_TIMEOUT_MS = '20'
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'idle-stream' },
    }),
  ).toString('base64url')}.x`
  try {
    const auth = join(directory, 'account.json')
    await writeFile(
      auth,
      JSON.stringify({
        tokens: { id_token: token, access_token: token, refresh_token: 'idle' },
      }),
    )
    await importChatGPTAuthFiles([auth])
    const stream = await createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async () =>
        new Response(
          new ReadableStream<Uint8Array>(),
        )) as unknown as typeof fetch,
      onAccountUnavailable: () => ({
        async *[Symbol.asyncIterator]() {
          yield { fallback: true }
        },
      }),
    })
    expect(await Array.fromAsync(stream)).toEqual([{ fallback: true }])
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    if (timeout === undefined) delete process.env.CHATGPT_RESPONSES_TIMEOUT_MS
    else process.env.CHATGPT_RESPONSES_TIMEOUT_MS = timeout
    await rm(directory, { recursive: true, force: true })
  }
})

test('falls through instead of failing when the Codex upstream is unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-upstream-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'upstream-error' },
    }),
  ).toString('base64url')}.x`
  try {
    const auth = join(directory, 'account.json')
    await writeFile(
      auth,
      JSON.stringify({
        tokens: {
          id_token: token,
          access_token: token,
          refresh_token: 'retry',
        },
      }),
    )
    await importChatGPTAuthFiles([auth])
    const stream = createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async () =>
        new Response('temporarily overloaded', {
          status: 503,
          statusText: 'Service Unavailable',
        })) as unknown as typeof fetch,
      onAccountUnavailable: () => ({
        async *[Symbol.asyncIterator]() {
          yield { fallback: true }
        },
      }),
    })
    expect(await Array.fromAsync(stream)).toEqual([{ fallback: true }])
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})

test('falls through when Codex reports an overloaded upstream in SSE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-overloaded-'))
  const configDirectory = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'overloaded' },
    }),
  ).toString('base64url')}.x`
  try {
    const auth = join(directory, 'account.json')
    await writeFile(
      auth,
      JSON.stringify({
        tokens: {
          id_token: token,
          access_token: token,
          refresh_token: 'retry',
        },
      }),
    )
    await importChatGPTAuthFiles([auth])
    const stream = createChatGPTResponsesStream({
      request: buildResponsesRequest({
        model: 'gpt-5.6-terra',
        messages: [],
        tools: [],
        toolChoice: undefined,
        promptCacheKey: 'ccb:test',
      }),
      signal: new AbortController().signal,
      fetchOverride: (async () =>
        new Response(
          `data: ${JSON.stringify({
            type: 'response.failed',
            response: {
              error: {
                code: 'server_error',
                message: 'Our servers are currently overloaded.',
              },
            },
          })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        )) as unknown as typeof fetch,
      onAccountUnavailable: () => ({
        async *[Symbol.asyncIterator]() {
          yield { fallback: true }
        },
      }),
    })
    expect(await Array.fromAsync(stream)).toEqual([{ fallback: true }])
  } finally {
    await removeChatGPTAuth()
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configDirectory
    await rm(directory, { recursive: true, force: true })
  }
})
