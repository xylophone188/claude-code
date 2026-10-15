import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { APIConnectionError, APIError } from 'openai'

mock.module('src/services/providerRegistry/loader.ts', () => ({
  findProvider: () => undefined,
  loadProviders: () => [],
}))

const {
  retryCcbOpenAIStream,
  StreamAttemptTimeoutError,
  isLocalGateway18800Error,
  healAgentboxGateway,
} = await import('../index.js')
const { RetryBudgetExhaustedError } = await import('../../withRetry.js')

function streamOf(
  ...events: ChatCompletionChunk[]
): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events
    },
  }
}

const textChunk = (text: string) =>
  ({
    id: 'test',
    choices: [{ delta: { content: text }, finish_reason: null, index: 0 }],
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
  }) as ChatCompletionChunk

const finishChunk = {
  id: 'test',
  choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
  created: 0,
  model: 'test',
  object: 'chat.completion.chunk',
} as ChatCompletionChunk

function statusError(status: number, message: string): APIError {
  // Pass a null body so the SDK falls back to `message`; a non-null `{}` body
  // would make the SDK message `${status} {}` and drop the human text.
  return new APIError(status, null as unknown as object, message, undefined)
}

describe('retryCcbOpenAIStream', () => {
  beforeEach(() => {
    process.env.CCB_INTERNAL_ROUTER = '1'
    delete process.env.CLAUDE_CODE_MAX_RETRIES
  })

  afterAll(() => {
    delete process.env.CCB_INTERNAL_ROUTER
    delete process.env.CLAUDE_CODE_MAX_RETRIES
  })

  test('retries router 503 before returning output', async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryCcbOpenAIStream(
        async () => {
          attempts++
          if (attempts === 1) throw statusError(503, 'all providers failed')
          return streamOf(textChunk('ok'), finishChunk)
        },
        new AbortController().signal,
        2,
        1000,
        () => Promise.resolve(),
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toHaveLength(2)
  })

  test('retries 429 and connection failures', async () => {
    let attempts = 0

    await Array.fromAsync(
      retryCcbOpenAIStream(
        async () => {
          attempts++
          if (attempts === 1) throw statusError(429, 'rate limited')
          if (attempts === 2)
            throw new APIConnectionError({ message: 'Connection error.' })
          return streamOf(textChunk('ok'), finishChunk)
        },
        new AbortController().signal,
        2,
        1000,
        () => Promise.resolve(),
      ),
    )

    expect(attempts).toBe(3)
  })

  test('does not retry permanent 400', async () => {
    let attempts = 0

    await expect(
      Array.fromAsync(
        retryCcbOpenAIStream(
          async () => {
            attempts++
            throw statusError(400, 'bad request')
          },
          new AbortController().signal,
          2,
          1000,
          () => Promise.resolve(),
        ),
      ),
    ).rejects.toThrow('bad request')

    expect(attempts).toBe(1)
  })

  test('throws RetryBudgetExhaustedError when budget expires', async () => {
    let attempts = 0

    await expect(
      Array.fromAsync(
        retryCcbOpenAIStream(
          async () => {
            attempts++
            throw statusError(503, 'all providers failed')
          },
          new AbortController().signal,
          5,
          0,
          () => Promise.resolve(),
        ),
      ),
    ).rejects.toBeInstanceOf(RetryBudgetExhaustedError)

    expect(attempts).toBe(1)
  })

  test('retries StreamAttemptTimeoutError', async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryCcbOpenAIStream(
        async () => {
          attempts++
          if (attempts === 1)
            throw new StreamAttemptTimeoutError('first')
          return streamOf(textChunk('ok after timeout'), finishChunk)
        },
        new AbortController().signal,
        2,
        1000,
        () => Promise.resolve(),
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toHaveLength(2)
  })

  test('retries an empty gateway stream before returning output', async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryCcbOpenAIStream(
        async () => {
          attempts++
          if (attempts === 1) return streamOf(finishChunk)
          return streamOf(textChunk('ok after empty stream'), finishChunk)
        },
        new AbortController().signal,
        2,
        1000,
        () => Promise.resolve(),
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toHaveLength(2)
  })

  test('identifies 127.0.0.1:18800 connection errors correctly', () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:18800/v1'
    const connErr = new APIConnectionError({ message: 'Connection error.' })
    expect(isLocalGateway18800Error(connErr)).toBe(true)

    const rawRefused = new Error('connect ECONNREFUSED 127.0.0.1:18800')
    expect(isLocalGateway18800Error(rawRefused)).toBe(true)

    const otherUrlErr = new Error('connect ECONNREFUSED 192.168.1.1:80')
    expect(
      isLocalGateway18800Error(otherUrlErr, 'http://192.168.1.1:80/v1'),
    ).toBe(false)
  })

  test('healAgentboxGateway polls health checker and recovers', async () => {
    let polls = 0
    let runnerCalled = false
    const healed = await healAgentboxGateway({
      healthTimeoutMs: 1000,
      pollIntervalMs: 50,
      runner: () => {
        runnerCalled = true
      },
      healthChecker: async () => {
        polls++
        return polls >= 2
      },
    })

    expect(runnerCalled).toBe(true)
    expect(healed).toBe(true)
    expect(polls).toBe(2)
  })

  test('heals local gateway on connection failure and retries stream immediately', async () => {
    process.env.OPENAI_BASE_URL = 'http://127.0.0.1:18800/v1'
    let attempts = 0

    const events = await Array.fromAsync(
      retryCcbOpenAIStream(
        async () => {
          attempts++
          if (attempts === 1) {
            throw new APIConnectionError({ message: 'Connection error.' })
          }
          return streamOf(textChunk('healed output'), finishChunk)
        },
        new AbortController().signal,
        2,
        2000,
        () => Promise.resolve(),
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toHaveLength(2)
  })
})
