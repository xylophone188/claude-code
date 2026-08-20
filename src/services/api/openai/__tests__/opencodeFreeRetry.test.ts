import { describe, expect, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import {
  autoTierTtfsTimeoutMs,
  raceDirectProviderStream,
  retryTierDirectProviderStream,
  retryDirectProviderStream,
  retryOpencodeFreeStream,
} from '../index.js'
import type { DirectRoute } from '../../../omniroute/adapter.js'

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

describe('retryOpencodeFreeStream', () => {
  test('recreates request after an empty stream', async () => {
    let attempts = 0
    const events = []
    for await (const event of retryOpencodeFreeStream(async () => {
      attempts++
      return attempts === 1 ? streamOf(finishChunk) : streamOf(textChunk('ok'))
    })) {
      events.push(event)
    }

    expect(attempts).toBe(2)
    expect(events).toHaveLength(1)
    expect(
      (events[0] as { choices: [{ delta: { content: string } }] }).choices[0]
        .delta.content,
    ).toBe('ok')
  })

  test('retries stream creation errors', async () => {
    let attempts = 0
    const events = []
    for await (const event of retryOpencodeFreeStream(async () => {
      attempts++
      if (attempts === 1) throw new Error('HTTP 503')
      return streamOf(textChunk('ok'))
    })) {
      events.push(event)
    }

    expect(attempts).toBe(2)
    expect(events).toHaveLength(1)
    expect(
      (events[0] as { choices: [{ delta: { content: string } }] }).choices[0]
        .delta.content,
    ).toBe('ok')
  })

  test('throws after repeated empty streams (11 total tries = 1 + 10 retries)', async () => {
    let attempts = 0
    const consume = async () => {
      for await (const _event of retryOpencodeFreeStream(async () => {
        attempts++
        return streamOf(finishChunk)
      })) {
        // consume
      }
    }

    await expect(consume()).rejects.toThrow('empty stream')
    expect(attempts).toBe(11)
  })

  test('does not retry after abort', async () => {
    const controller = new AbortController()
    controller.abort()
    let attempts = 0
    const consume = async () => {
      for await (const _event of retryOpencodeFreeStream(async () => {
        attempts++
        return streamOf(textChunk('ok'))
      }, controller.signal)) {
        // consume
      }
    }

    await expect(consume()).rejects.toThrow()
    expect(attempts).toBe(0)
  })

  test('converts DSML tool calls instead of retrying', async () => {
    let attempts = 0
    const consume = async () => {
      for await (const _event of retryOpencodeFreeStream(async () => {
        attempts++
        return streamOf(textChunk('<｜DSML｜tool_calls>'))
      })) {
        // consume
      }
    }

    await expect(consume()).resolves.toBeUndefined()

    expect(attempts).toBe(1)
  })
})

test('skips sibling accounts after a provider-wide failure', async () => {
  const route = (providerId: string, accountId: string): DirectRoute => ({
    providerId,
    accountId,
    baseURL: 'https://example.test/v1',
    model: 'model',
    apiKey: 'test',
    kind: 'provider',
  })
  const calls: string[] = []
  const stream = retryDirectProviderStream(
    [route('failed', 'one'), route('failed', 'two'), route('next', 'one')],
    async current => {
      calls.push(`${current.providerId}/${current.accountId}`)
      if (current.providerId === 'failed') throw new Error('connection failed')
      return streamOf(textChunk('ok'))
    },
    new AbortController().signal,
  )

  expect(await Array.fromAsync(stream)).toHaveLength(1)
  expect(calls).toEqual(['failed/one', 'next/one'])
})

test('delegates cross-request cooldown to OmniRoute', async () => {
  const route = (providerId: string): DirectRoute => ({
    providerId,
    baseURL: 'https://example.test/v1',
    model: 'model',
    apiKey: 'test',
    kind: 'provider',
  })
  const failed = route(`failed-${Date.now()}`)
  await expect(
    Array.fromAsync(
      retryDirectProviderStream(
        [failed],
        async () => {
          throw new Error('connection failed')
        },
        new AbortController().signal,
      ),
    ),
  ).rejects.toThrow('connection failed')

  const calls: string[] = []
  expect(
    await Array.fromAsync(
      retryDirectProviderStream(
        [failed, route('healthy')],
        async current => {
          calls.push(current.providerId)
          return streamOf(textChunk('ok'))
        },
        new AbortController().signal,
      ),
    ),
  ).toHaveLength(1)
  expect(calls).toEqual([failed.providerId])
})

test('accepts DSML tool calls without cooling down model', async () => {
  const route = (providerId: string, model: string): DirectRoute => ({
    providerId,
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
  })
  const calls: string[] = []
  const stream = retryDirectProviderStream(
    [route('first', 'bad'), route('first', 'bad'), route('next', 'good')],
    async current => {
      calls.push(`${current.providerId}/${current.model}`)
      return current.providerId === 'first'
        ? streamOf(textChunk('<｜DSML｜tool_calls>'))
        : streamOf(textChunk('ok'))
    },
    new AbortController().signal,
  )

  expect(await Array.fromAsync(stream)).toHaveLength(1)
  expect(calls).toEqual(['first/bad'])
})

test('records each concurrent contender outcome', async () => {
  const route = (model: string): DirectRoute => ({
    providerId: 'race-test',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
  })
  const slow = route(`slow-${Date.now()}`)
  const fast = route(`fast-${Date.now()}`)
  const events = await Array.fromAsync(
    raceDirectProviderStream(
      [slow, fast],
      async current => {
        if (current === slow)
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise(resolve => setTimeout(resolve, 20))
              yield textChunk('slow')
            },
          }
        return streamOf(textChunk('fast'))
      },
      new AbortController().signal,
    ),
  )

  expect(events).toHaveLength(1)
  expect(
    (events[0] as unknown as { choices: [{ delta: { content: string } }] })
      .choices[0].delta.content,
  ).toBe('fast')
})

test('does not wait for a delayed extra contender once the quorum is satisfied', async () => {
  // Quorum-based selection (default RACE_QUORUM=3): a slow trailing route must
  // not delay the decision once enough faster routes have already responded.
  // With 4 routes the quorum is 3, so the 4th (delayed) route is not awaited.
  const route = (model: string, raceDelayMs: number): DirectRoute => ({
    providerId: 'race-delay',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race: true,
    raceDelayMs,
  })
  const fastA = route(`fastA-${Date.now()}`, 0)
  const fastB = route(`fastB-${Date.now()}`, 0)
  const fastC = route(`fastC-${Date.now()}`, 0)
  const delayed = route(`delayed-${Date.now()}`, 500)
  // Give fastB the longest early content so it wins the quorum by score.
  const started = Date.now()
  const events = await Array.fromAsync(
    raceDirectProviderStream(
      [fastA, fastB, fastC, delayed],
      async current =>
        streamOf(
          textChunk(
            current === fastA
              ? 'a'
              : current === fastB
                ? 'bbbbb'
                : current === fastC
                  ? 'c'
                  : 'delayed',
          ),
        ),
      new AbortController().signal,
    ),
  )

  // The delayed 4th contender must not extend the decision past its 500ms delay.
  expect(Date.now() - started).toBeLessThan(200)
  expect(
    (events[0] as unknown as { choices: [{ delta: { content: string } }] })
      .choices[0].delta.content,
  ).toBe('bbbbb')
})

test('uses CCB tier TTFS budgets', () => {
  expect([1, 2, 3, 4, 5, 6].map(autoTierTtfsTimeoutMs)).toEqual([
    4_000, 8_000, 12_000, 16_000, 20_000, 24_000,
  ])
})

test('continues within a tier after TTFS timeout', async () => {
  const route = (model: string): DirectRoute => ({
    providerId: 'tier-timeout',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
  })
  const slow = route('slow')
  const fast = route('fast')
  const calls: string[] = []
  const events = await Array.fromAsync(
    retryTierDirectProviderStream(
      [slow, fast],
      10,
      async (current, signal) => {
        calls.push(current.model)
        if (current === slow)
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise<void>((_, reject) =>
                signal.addEventListener(
                  'abort',
                  () => reject(new Error('aborted')),
                  {
                    once: true,
                  },
                ),
              )
            },
          }
        return streamOf(textChunk('ok'))
      },
      new AbortController().signal,
    ),
  )

  expect(calls).toEqual(['slow', 'fast'])
  expect(events).toHaveLength(1)
})

test('keeps valid stream after TTFS arrives', async () => {
  const route: DirectRoute = {
    providerId: 'tier-ttfs',
    baseURL: 'https://example.test/v1',
    model: 'model',
    apiKey: 'test',
    kind: 'provider',
  }
  const events = await Array.fromAsync(
    retryTierDirectProviderStream(
      [route],
      10,
      async () => ({
        async *[Symbol.asyncIterator]() {
          yield textChunk('ok')
          await new Promise(resolve => setTimeout(resolve, 30))
          yield finishChunk
        },
      }),
      new AbortController().signal,
    ),
  )

  expect(events).toHaveLength(2)
})
