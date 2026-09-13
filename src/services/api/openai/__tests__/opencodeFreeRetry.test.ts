import { describe, expect, jest, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import {
  autoTierTtfsTimeoutMs,
  raceDirectProviderStream,
  raceThenFallbackStream,
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

const omnirouteRoute = (): DirectRoute => ({
  providerId: 'omniroute',
  baseURL: 'http://127.0.0.1:8787/v1',
  model: 'auto/smart',
  apiKey: 'test',
  kind: 'provider',
})

async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  jest.useFakeTimers()
  try {
    let settled = false
    const result = run()
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    for (let ticks = 0; !settled; ticks++) {
      if (ticks === 100)
        throw new Error('fake-timer test did not settle after 100 ticks')
      await Promise.resolve()
      if (jest.getTimerCount() > 0) jest.runOnlyPendingTimers()
    }
    await result
  } finally {
    jest.useRealTimers()
  }
}

test('streams a successful OmniRoute response', async () => {
  let attempts = 0
  const events = await Array.fromAsync(
    retryDirectProviderStream(
      [omnirouteRoute()],
      async () => {
        attempts++
        return streamOf(textChunk('ok'), finishChunk)
      },
      new AbortController().signal,
    ),
  )

  expect(attempts).toBe(1)
  expect(events).toEqual([textChunk('ok'), finishChunk])
})

test('retries OmniRoute after a 502 before output', async () => {
  await withFakeTimers(async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          if (attempts === 1)
            throw Object.assign(new Error('Bad Gateway'), { status: 502 })
          return streamOf(textChunk('ok'))
        },
        new AbortController().signal,
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toEqual([textChunk('ok')])
  })
})

test('retries OmniRoute after ECONNRESET before output', async () => {
  await withFakeTimers(async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          if (attempts === 1)
            throw Object.assign(new Error('read ECONNRESET'), {
              code: 'ECONNRESET',
            })
          return streamOf(textChunk('ok'))
        },
        new AbortController().signal,
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toEqual([textChunk('ok')])
  })
})

test('limits OmniRoute transient failures to six attempts', async () => {
  let attempts = 0
  const retryImmediately = Object.assign(new Error('Bad Gateway'), {
    status: 502,
    headers: new Headers({ 'retry-after': '0' }),
  })
  await expect(
    Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          throw retryImmediately
        },
        new AbortController().signal,
      ),
    ),
  ).rejects.toThrow('Bad Gateway')
  expect(attempts).toBe(6)
})

test('does not retry a non-OmniRoute route after a bare 502', async () => {
  const route: DirectRoute = {
    providerId: 'another-provider',
    baseURL: 'https://example.test/v1',
    model: 'model',
    apiKey: 'test',
    kind: 'provider',
  }
  let attempts = 0
  await expect(
    Array.fromAsync(
      retryDirectProviderStream(
        [route],
        async () => {
          attempts++
          throw Object.assign(new Error('Bad Gateway'), { status: 502 })
        },
        new AbortController().signal,
      ),
    ),
  ).rejects.toThrow('Bad Gateway')
  expect(attempts).toBe(1)
})

test('retries OmniRoute after an empty stream before output', async () => {
  await withFakeTimers(async () => {
    let attempts = 0
    const events = await Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          if (attempts === 1) return streamOf(finishChunk)
          return streamOf(textChunk('ok'), finishChunk)
        },
        new AbortController().signal,
      ),
    )

    expect(attempts).toBe(2)
    expect(events).toEqual([textChunk('ok'), finishChunk])
  })
})

test('does not retry OmniRoute 4xx errors', async () => {
  let attempts = 0
  await expect(
    Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          throw Object.assign(new Error('Unauthorized'), { status: 401 })
        },
        new AbortController().signal,
      ),
    ),
  ).rejects.toThrow('Unauthorized')
  expect(attempts).toBe(1)
})

test('does not replay OmniRoute after meaningful output', async () => {
  let attempts = 0
  await expect(
    Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          return {
            async *[Symbol.asyncIterator]() {
              yield textChunk('partial')
              throw Object.assign(new Error('connection reset'), {
                code: 'ECONNRESET',
              })
            },
          }
        },
        new AbortController().signal,
      ),
    ),
  ).rejects.toThrow('connection reset')
  expect(attempts).toBe(1)
})

test('cancels OmniRoute retry backoff', async () => {
  jest.useFakeTimers()
  try {
    const controller = new AbortController()
    let attempts = 0
    const consume = Array.fromAsync(
      retryDirectProviderStream(
        [omnirouteRoute()],
        async () => {
          attempts++
          throw Object.assign(new Error('Bad Gateway'), { status: 502 })
        },
        controller.signal,
      ),
    )
    while (jest.getTimerCount() === 0) await Promise.resolve()
    controller.abort()

    await expect(consume).rejects.toThrow()
    expect(attempts).toBe(1)
    expect(jest.getTimerCount()).toBe(0)
  } finally {
    jest.useRealTimers()
  }
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

test('raceThenFallbackStream does not replay meaningful output', async () => {
  const route = (model: string, race: boolean): DirectRoute => ({
    providerId: 'tier-noreplay',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race,
  })
  const l1 = route('l1', true)
  const l2 = route('l2', false)
  let l1Calls = 0
  let l2Calls = 0
  let caught: unknown
  try {
    for await (const _event of raceThenFallbackStream(
      [[l1], [l2]],
      async current => {
        if (current === l1) {
          l1Calls++
          return {
            async *[Symbol.asyncIterator]() {
              yield textChunk('partial')
              throw {
                status: 502,
                message: 'all gateway backends unavailable',
              }
            },
          }
        }
        l2Calls++
        return streamOf(textChunk('l2'))
      },
      new AbortController().signal,
    )) {
      void _event
    }
  } catch (e) {
    caught = e
  }

  // Under the complete-result quorum rule, a stream that only produced
  // 'partial' before failing is not a valid candidate; L2 regenerates the
  // turn with a fresh complete response.
  expect(l1Calls).toBe(1)
  expect(l2Calls).toBe(1)
  expect(caught).toBeUndefined()
})

test('raceThenFallbackStream falls through to L2 before any output', async () => {
  const route = (model: string, race: boolean): DirectRoute => ({
    providerId: 'tier-fallthrough',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race,
  })
  const l1 = route('l1', true)
  const l2 = route('l2', false)
  let l2Calls = 0
  const events = await Array.fromAsync(
    raceThenFallbackStream(
      [[l1], [l2]],
      async current => {
        if (current === l1)
          return {
            // biome-ignore lint/correctness/useYield: generator always throws
            async *[Symbol.asyncIterator]() {
              throw {
                status: 502,
                message: 'all gateway backends unavailable',
              }
            },
          }
        l2Calls++
        return streamOf(textChunk('l2-answer'))
      },
      new AbortController().signal,
    ),
  )

  // No L1 output was produced, so escalating to L2 is a clean retry.
  expect(l2Calls).toBe(1)
  expect(events).toHaveLength(1)
  expect(
    (events[0] as unknown as { choices: [{ delta: { content: string } }] })
      .choices[0].delta.content,
  ).toBe('l2-answer')
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

test('does not switch tier routes after meaningful output', async () => {
  const route = (model: string): DirectRoute => ({
    providerId: 'tier-noreplay',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
  })
  const first = route('first')
  const second = route('second')
  const originalError = { status: 500, message: 'stream failed' }
  let secondCalls = 0
  let caught: unknown
  try {
    for await (const _event of retryTierDirectProviderStream(
      [first, second],
      100,
      async current => {
        if (current === first)
          return {
            async *[Symbol.asyncIterator]() {
              yield textChunk('partial')
              throw originalError
            },
          }
        secondCalls++
        return streamOf(textChunk('replacement'))
      },
      new AbortController().signal,
    )) {
      void _event
    }
  } catch (e) {
    caught = e
  }

  expect(secondCalls).toBe(0)
  expect(caught).toBe(originalError)
})

test('raceThenFallbackStream surfaces the last exhausted tier error', async () => {
  const route = (model: string, race: boolean): DirectRoute => ({
    providerId: 'tier-lasterror',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race,
  })
  const l1 = route('l1', true)
  const l2 = route('l2', false)
  const l1Error = { status: 500, message: 'stale L1 failure' }
  const l2Error = { status: 400, message: 'final route rejected' }
  let caught: unknown
  try {
    for await (const _event of raceThenFallbackStream(
      [[l1], [l2]],
      async current => ({
        // biome-ignore lint/correctness/useYield: generator always throws
        async *[Symbol.asyncIterator]() {
          throw current === l1 ? l1Error : l2Error
        },
      }),
      new AbortController().signal,
    )) {
      void _event
    }
  } catch (e) {
    caught = e
  }

  // After every tier's budget is exhausted, the surfaced error is the one from
  // the most recently exhausted route, not the stale L1 failure.
  expect(caught).toBe(l2Error)
})

test('all-of single completed contender does not replay into L2 after output', async () => {
  const route = (model: string, race: boolean): DirectRoute => ({
    providerId: 'tier-allof',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race,
  })
  const l1a = route('l1a', true)
  const l1b = route('l1b', true)
  const l2 = route('l2', false)
  const gateway502 = {
    status: 502,
    message: 'all gateway backends unavailable',
  }
  let l1aStreamCalls = 0
  let l2Calls = 0
  let caught: unknown

  process.env.CCB_RACE_ALL_OF = 'best'
  try {
    for await (const _event of raceThenFallbackStream(
      [[l1a, l1b], [l2]],
      async current => {
        if (current === l1b)
          return {
            // biome-ignore lint/correctness/useYield: generator always throws
            async *[Symbol.asyncIterator]() {
              throw gateway502
            },
          }
        if (current === l1a) {
          l1aStreamCalls++
          if (l1aStreamCalls === 1) return streamOf(textChunk('ok'))
          return {
            async *[Symbol.asyncIterator]() {
              yield textChunk('partial')
              throw gateway502
            },
          }
        }
        l2Calls++
        return streamOf(textChunk('l2'))
      },
      new AbortController().signal,
    )) {
      void _event
    }
  } catch (e) {
    caught = e
  } finally {
    delete process.env.CCB_RACE_ALL_OF
  }

  // The single completed contender recreated its stream, produced meaningful
  // output, then failed: the failure propagates instead of regenerating via L2.
  expect(l1aStreamCalls).toBe(2)
  expect(l2Calls).toBe(0)
  expect(caught).toBe(gateway502)
})

test('all-of no quorum falls through to L2 before any output', async () => {
  const route = (model: string, race: boolean): DirectRoute => ({
    providerId: 'tier-noquorum',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race,
  })
  const l1a = route('l1a', true)
  const l1b = route('l1b', true)
  const l2 = route('l2', false)
  let l2Calls = 0

  process.env.CCB_RACE_ALL_OF = 'best'
  try {
    const events = await Array.fromAsync(
      raceThenFallbackStream(
        [[l1a, l1b], [l2]],
        async current => {
          if (current === l1a || current === l1b)
            return {
              // biome-ignore lint/correctness/useYield: generator always throws
              async *[Symbol.asyncIterator]() {
                throw {
                  status: 502,
                  message: 'all gateway backends unavailable',
                }
              },
            }
          l2Calls++
          return streamOf(textChunk('l2-answer'))
        },
        new AbortController().signal,
      ),
    )

    expect(events).toHaveLength(1)
    expect(
      (events[0] as unknown as { choices: [{ delta: { content: string } }] })
        .choices[0].delta.content,
    ).toBe('l2-answer')
  } finally {
    delete process.env.CCB_RACE_ALL_OF
  }

  // No L1 contender completed, so L2 is a clean retry, not a replay.
  expect(l2Calls).toBe(1)
})

test('race waits for complete results and rejects empty streams', async () => {
  const route = (model: string): DirectRoute => ({
    providerId: 'race-integrity',
    baseURL: 'https://example.test/v1',
    model,
    apiKey: 'test',
    kind: 'provider',
    race: true,
  })
  const routes = [route('empty'), route('complete'), route('second')]
  const events = []
  for await (const event of raceDirectProviderStream(
    routes,
    async current =>
      current.model === 'empty'
        ? streamOf(finishChunk)
        : streamOf(
            textChunk(`${current.model} complete response`),
            finishChunk,
          ),
    new AbortController().signal,
  )) {
    events.push(event)
  }
  expect(events.length).toBeGreaterThan(0)
  expect(
    (events[0] as unknown as { choices: [{ delta: { content: string } }] })
      .choices[0].delta.content,
  ).toBe('complete complete response')
})
