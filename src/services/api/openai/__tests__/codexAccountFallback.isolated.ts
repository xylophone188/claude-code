/**
 * Tests for createChatGPTResponsesStream's account-exhaustion fallback.
 *
 * When the ChatGPT Codex account pool is dead (no valid token / all accounts
 * quota-locked), the caller must be able to supply `onAccountExhausted` /
 * `onAccountUnavailable` fallbacks so the request recovers via an alternate
 * provider instead of surfacing a hard error. This is exactly what the
 * `gpt-5.6-terra` chat path now relies on (it previously wired these callbacks
 * only for the `advisor` model).
 *
 * We mock chatgptAuth so no real token/auth file is touched.
 */
import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import {
  createChatGPTResponsesStream,
  chatCompletionsToResponses,
} from '../responsesAdapter.js'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'

// Mutable so individual tests can flip between "no valid account" and "valid".
let mockAuth: 'valid' | 'throw' = 'valid'

mock.module('../chatgptAuth.js', () => ({
  isChatGPTAuthEnabled: () => true,
  getValidChatGPTAuth: async () => {
    if (mockAuth === 'throw') {
      throw new Error('No ChatGPT account has a valid token.')
    }
    return { accessToken: 'tok', accountId: 'acc-1' }
  },
  markChatGPTAccountFailure: () => {},
  markChatGPTAccountAuthRejected: async () => {},
  markChatGPTAccountQuotaExhausted: async () => {},
  clearChatGPTAccountFailure: () => {},
}))

function fallbackChunks(): ChatCompletionChunk[] {
  return [
    {
      choices: [
        { delta: { content: 'fallback answer' }, finish_reason: 'stop' },
      ],
    } as unknown as ChatCompletionChunk,
  ]
}

function fallbackStream(): AsyncIterable<ChatCompletionChunk> {
  return (async function* () {
    for (const c of fallbackChunks()) yield c
  })()
}

const baseRequest = {
  model: 'gpt-5.6-terra',
  stream: true,
  store: false,
  input: [],
  prompt_cache_key: 'ccb:test',
} as any

describe('createChatGPTResponsesStream — account fallback', () => {
  afterEach(() => {
    delete process.env.CHATGPT_RESPONSES_TIMEOUT_MS
    mockAuth = 'valid'
  })

  test('exhausted pool yields onAccountExhausted fallback content (no throw)', async () => {
    mockAuth = 'throw'
    const events: any[] = []
    await expect(
      (async () => {
        for await (const ev of createChatGPTResponsesStream({
          request: baseRequest,
          signal: new AbortController().signal,
          onAccountExhausted: () =>
            chatCompletionsToResponses(fallbackStream()),
        })) {
          events.push(ev)
        }
      })(),
    ).resolves.toBeUndefined()

    const hasFallbackText = events.some(
      e =>
        e.type === 'response.output_text.delta' &&
        e.delta === 'fallback answer',
    )
    expect(hasFallbackText).toBe(true)
  })

  test('timed-out request yields onAccountUnavailable fallback content', async () => {
    // Valid account, but the upstream fetch hangs forever so the idle
    // timeout fires and the request must fall back.
    mockAuth = 'valid'
    process.env.CHATGPT_RESPONSES_TIMEOUT_MS = '10'
    // Hangs on the response body but rejects the moment the idle-timeout
    // AbortController fires (its signal is passed as the fetch signal).
    const abortingFetch = (_url: string, init?: any) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted by timeout')),
          { once: true },
        )
      })

    const events: any[] = []
    await expect(
      (async () => {
        for await (const ev of createChatGPTResponsesStream({
          request: baseRequest,
          signal: new AbortController().signal,
          fetchOverride: abortingFetch as unknown as typeof fetch,
          onAccountUnavailable: () =>
            chatCompletionsToResponses(fallbackStream()),
        })) {
          events.push(ev)
        }
      })(),
    ).resolves.toBeUndefined()

    const hasFallbackText = events.some(
      e =>
        e.type === 'response.output_text.delta' &&
        e.delta === 'fallback answer',
    )
    expect(hasFallbackText).toBe(true)
  })

  test('exhausted pool WITHOUT a fallback still throws (caller must opt in)', async () => {
    mockAuth = 'throw'
    await expect(
      (async () => {
        for await (const _ev of createChatGPTResponsesStream({
          request: baseRequest,
          signal: new AbortController().signal,
        })) {
          // drain
        }
      })(),
    ).rejects.toThrow(/No ChatGPT account/)
  })
})
