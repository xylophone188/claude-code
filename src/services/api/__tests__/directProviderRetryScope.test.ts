import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import {
  retryDirectProviderStream,
  raceDirectProviderStream,
} from '../openai/index.js'
import { isGatewayUnavailable } from '../../omniroute/adapter.js'
import { resetCircuitBreaker } from '../../routing/circuitBreaker.js'

beforeEach(() => {
  mock.restore()
  resetCircuitBreaker()
})

type TestDirectRoute = {
  providerId: string
  baseURL: string
  model: string
  apiKey: string
  kind: 'provider'
  accountId: string
  timeoutMs?: number
}

function meaningfulChunk(
  _providerId: string,
  model: string,
  _account: string,
  text: string,
): ChatCompletionChunk {
  return {
    id: `chatcmpl-test`,
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: text },
        finish_reason: text ? null : 'stop',
      },
    ],
  } as ChatCompletionChunk
}

function makeRoute(
  providerId: string,
  model: string,
  account: string,
): TestDirectRoute {
  return {
    providerId,
    baseURL: `https://api.${providerId}.com/v1`,
    model,
    apiKey: 'key',
    kind: 'provider',
    accountId: account,
  }
}

async function drainGen(gen: AsyncGenerator<unknown>) {
  const chunks: unknown[] = []
  let next = await gen.next()
  while (!next.done) {
    chunks.push(next.value)
    next = await gen.next()
  }
  return chunks
}

async function drainGenCatch(gen: AsyncGenerator<unknown>) {
  try {
    return { ok: true, chunks: await drainGen(gen) }
  } catch (e) {
    return { ok: false, error: e }
  }
}

// Resolve retry backoffs immediately so bounded-retry tests run without real
// waits. Injected through the stream's backoff seam — never by stubbing
// globalThis.setTimeout, which would pollute other tests in the process.
const noopBackoff = async () => {}

describe('retryDirectProviderStream scope routing', () => {
  test('connection error retries the same custom route with backoff', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const chunks = await drainGen(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              if (attempt === 1) throw new Error('Connection error')
              yield meaningfulChunk('omniroute', 'ccb-main', 'gateway', 'ok')
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks).toHaveLength(1)
  })

  test('non-retryable 400 does not replay the custom route', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw { status: 400, message: 'Bad Request' }
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(1)
  })

  test('429 (account scope) retries next account of same provider', async () => {
    let attempt = 0
    const routes = [
      makeRoute('nvidia', 'glm-5.2', 'acct1'),
      makeRoute('nvidia', 'glm-5.2', 'acct2'),
    ]
    const chunks = await drainGen(
      retryDirectProviderStream(
        routes as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              if (attempt === 1)
                throw { status: 429, message: 'Too Many Requests' }
              yield meaningfulChunk('nvidia', 'glm-5.2', 'acct2', 'hello')
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect((chunks[0] as ChatCompletionChunk).model).toBe('glm-5.2')
  })

  test('500 (provider scope) skips entire provider including remaining accounts', async () => {
    let attempt = 0
    const routes = [
      makeRoute('bad-provider', 'model', 'acct1'),
      makeRoute('bad-provider', 'model', 'acct2'),
      makeRoute('good-provider', 'glm-5.2', 'acct1'),
    ]
    const chunks = await drainGen(
      retryDirectProviderStream(
        routes as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              if (attempt === 1)
                throw { status: 500, message: 'Internal Server Error' }
              yield meaningfulChunk('good-provider', 'glm-5.2', 'acct1', 'ok')
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect((chunks[0] as ChatCompletionChunk).model).toBe('glm-5.2')
  })

  test('gateway 502 retries with slow backoff then succeeds after recovery', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const chunks = await drainGen(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              if (attempt === 1)
                throw {
                  status: 502,
                  message: 'all gateway backends unavailable',
                }
              yield meaningfulChunk('omniroute', 'ccb-main', 'gateway', 'ok')
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks).toHaveLength(1)
  })

  test('gateway 502 exhausts its retries then throws the original error', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw {
                status: 502,
                message: 'all gateway backends unavailable',
              }
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(result.ok).toBe(false)
    // 1 initial + 5 gateway retries, then the original 502 propagates.
    expect(attempt).toBe(6)
    expect((result.error as { status?: number }).status).toBe(502)
  })

  test('gateway-wide 503 exhausts the same six-attempt retry budget', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw {
                status: 503,
                message:
                  'upstream HTTP 503; all configured gateway backends failed',
              }
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(6)
    expect((result.error as { status?: number }).status).toBe(503)
  })

  test('gateway-wide 503 uses the exact 1/2/4/8/16s backoff sequence', async () => {
    let attempt = 0
    const delays: number[] = []
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw {
                status: 503,
                message: 'all configured gateway backends failed',
              }
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        async (ms: number) => {
          delays.push(ms)
        },
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(6)
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  test('gateway-wide 503 after meaningful output throws without replay', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              yield meaningfulChunk(
                'omniroute',
                'ccb-main',
                'gateway',
                'partial',
              )
              throw {
                status: 503,
                message: 'all configured gateway backends failed',
              }
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(1)
    expect((result.error as { status?: number }).status).toBe(503)
  })

  test('empty stream skips only its model and continues to a sibling model', async () => {
    const routes = [
      makeRoute('omniroute', 'empty-model', 'gateway'),
      makeRoute('omniroute', 'healthy-model', 'gateway'),
    ]
    const attemptedModels: string[] = []
    const chunks = await drainGen(
      retryDirectProviderStream(
        routes as never,
        current =>
          Promise.resolve(
            (async function* () {
              attemptedModels.push(current.model)
              if (current.model === 'empty-model') return
              yield meaningfulChunk('omniroute', current.model, 'gateway', 'ok')
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(attemptedModels).toEqual([
      'empty-model',
      'empty-model',
      'empty-model',
      'empty-model',
      'empty-model',
      'empty-model',
      'healthy-model',
    ])
    expect(chunks).toHaveLength(1)
    expect((chunks[0] as ChatCompletionChunk).model).toBe('healthy-model')
  })

  test('gateway 502 after meaningful output throws without replay', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              yield meaningfulChunk(
                'omniroute',
                'ccb-main',
                'gateway',
                'partial',
              )
              throw {
                status: 502,
                message: 'all gateway backends unavailable',
              }
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(result.ok).toBe(false)
    // Meaningful output must never be replayed: a retry would regenerate the
    // whole assistant turn, so the original 502 propagates after one attempt.
    expect(attempt).toBe(1)
    expect((result.error as { status?: number }).status).toBe(502)
  })

  test('gateway 502 uses the exact 1/2/4/8/16s backoff sequence', async () => {
    let attempt = 0
    const delays: number[] = []
    const originalError = {
      status: 502,
      message: 'all gateway backends unavailable',
    }
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw originalError
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        async (ms: number) => {
          delays.push(ms)
        },
      ),
    )
    expect(result.ok).toBe(false)
    // 1 initial + 5 gateway retries, then the original 502 object propagates.
    expect(attempt).toBe(6)
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(result.error).toBe(originalError)
  })

  test('429 gateway capacity exhaustion retries with retry-after then succeeds', async () => {
    let attempt = 0
    const delays: number[] = []
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const chunks = await drainGen(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              if (attempt === 1)
                throw {
                  status: 429,
                  message: 'gateway capacity exhausted',
                  headers: { get: () => '335' },
                }
              yield meaningfulChunk('omniroute', 'ccb-main', 'gateway', 'ok')
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        async (ms: number) => {
          delays.push(ms)
        },
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks).toHaveLength(1)
    // retry-after is honored but clamped to the gateway backoff ceiling.
    expect(delays).toEqual([16_000])
  })

  test('custom-route gateway 502 still gets the full 6-attempt gateway budget', async () => {
    let attempt = 0
    const delays: number[] = []
    const route = makeRoute('9router', 'gpt-5.6-sol', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw {
                status: 502,
                message: 'all gateway backends unavailable',
              }
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        async (ms: number) => {
          delays.push(ms)
        },
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(6)
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
  })

  test('opencode meaningful output is never replayed on failure', async () => {
    let attempt = 0
    const originalError = { status: 503, message: 'volatile upstream' }
    const route = {
      providerId: 'opencode',
      baseURL: 'https://example.test/v1',
      model: 'opencode-free',
      apiKey: 'key',
      kind: 'opencode',
      accountId: 'gateway',
    }
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              yield meaningfulChunk(
                'opencode',
                'opencode-free',
                'gateway',
                'partial',
              )
              throw originalError
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(result.ok).toBe(false)
    // The no-replay gate covers the opencode retry branch too.
    expect(attempt).toBe(1)
    expect(result.error).toBe(originalError)
  })

  test('generic 500 after meaningful output also throws without replay', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            (async function* () {
              attempt++
              yield meaningfulChunk(
                'omniroute',
                'ccb-main',
                'gateway',
                'partial',
              )
              throw { status: 500, message: 'Internal Server Error' }
            })(),
          ),
        new AbortController().signal,
      ),
    )
    expect(result.ok).toBe(false)
    // The no-replay gate covers every retry branch, not just gateway 502.
    expect(attempt).toBe(1)
    expect((result.error as { status?: number }).status).toBe(500)
  })

  test('non-gateway 500 keeps the generic fast retry budget', async () => {
    let attempt = 0
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const result = await drainGenCatch(
      retryDirectProviderStream(
        [route] as never,
        () =>
          Promise.resolve(
            // biome-ignore lint/correctness/useYield: generator always throws
            (async function* () {
              attempt++
              throw { status: 500, message: 'Internal Server Error' }
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        noopBackoff,
      ),
    )
    expect(result.ok).toBe(false)
    expect(attempt).toBe(3)
  })

  test('gateway backoff stays abort-aware while waiting', async () => {
    let attempt = 0
    const controller = new AbortController()
    const route = makeRoute('omniroute', 'ccb-main', 'gateway')
    const gen = retryDirectProviderStream(
      [route] as never,
      () =>
        Promise.resolve(
          // biome-ignore lint/correctness/useYield: generator always throws
          (async function* () {
            attempt++
            throw {
              status: 502,
              message: 'all gateway backends unavailable',
            }
          })(),
        ),
      controller.signal,
    )
    const next = gen.next()
    // Let the stream reach the 1s gateway backoff, then cancel mid-wait.
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(next).rejects.toThrow('aborted')
    expect(attempt).toBe(1)
  })
})

describe('isGatewayUnavailable', () => {
  test('matches 502 gateway_unavailable errors', () => {
    expect(
      isGatewayUnavailable({
        status: 502,
        message: 'all gateway backends unavailable',
      }),
    ).toBe(true)
    expect(
      isGatewayUnavailable({
        status: 502,
        message:
          '502 {"error":{"message":"all gateway backends unavailable","code":"gateway_unavailable"}}',
      }),
    ).toBe(true)
    expect(
      isGatewayUnavailable({ status: 502, message: 'gateway_unavailable' }),
    ).toBe(true)
  })

  test('rejects bare or unrelated errors', () => {
    expect(isGatewayUnavailable({ status: 502, message: 'Bad Gateway' })).toBe(
      false,
    )
    expect(
      isGatewayUnavailable({ status: 503, message: 'Service Unavailable' }),
    ).toBe(false)
    expect(
      isGatewayUnavailable({
        status: 503,
        message: 'all gateway backends unavailable',
      }),
    ).toBe(true)
    expect(isGatewayUnavailable({ status: 400, message: 'bad request' })).toBe(
      false,
    )
    expect(isGatewayUnavailable(new Error('Connection error'))).toBe(false)
  })
})

// Minimal chunk builders for the race selection tests.
const chunk = (text: string): ChatCompletionChunk =>
  ({
    choices: [{ index: 0, delta: { content: text } }],
  }) as unknown as ChatCompletionChunk
const reasoningChunk = (text: string): ChatCompletionChunk =>
  ({
    choices: [{ index: 0, delta: { reasoning_content: text } as never }],
  }) as unknown as ChatCompletionChunk

describe('raceDirectProviderStream selection', () => {
  const route = (model: string) =>
    ({
      providerId: 'test',
      baseURL: 'http://test',
      model,
      apiKey: 'k',
      kind: 'provider',
      race: true,
      tier: 'l1',
    }) as Parameters<typeof raceDirectProviderStream>[0][number]

  test('a reasoning-only fast leg must not beat a content-first leg', async () => {
    const reasoningRoute = route('reasoning-first')
    const contentRoute = route('content-first')
    const streams = async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield reasoningChunk('让我想想')
      await new Promise(resolve => setTimeout(resolve, 120))
      yield chunk('就位')
    }
    const fast = async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield chunk('就位')
    }
    const createStream = (r: typeof reasoningRoute) =>
      Promise.resolve(r === reasoningRoute ? streams() : fast())
    const collected: string[] = []
    for await (const event of raceDirectProviderStream(
      [reasoningRoute, contentRoute],
      createStream,
      new AbortController().signal,
    )) {
      collected.push(
        String(
          (event as { choices?: Array<{ delta?: { content?: string } }> })
            .choices?.[0]?.delta?.content ?? '',
        ),
      )
    }
    expect(collected.join('')).toContain('就位')
  })

  test('a leg whose stream ends with only reasoning fails, not wins', async () => {
    const emptyRoute = route('empty-stream')
    const contentRoute = route('content-first')
    const empty = async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield reasoningChunk('思考中……')
    }
    const good = async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield chunk('就位')
    }
    const createStream = (r: typeof emptyRoute) =>
      Promise.resolve(r === emptyRoute ? empty() : good())
    const collected: string[] = []
    for await (const event of raceDirectProviderStream(
      [emptyRoute, contentRoute],
      createStream,
      new AbortController().signal,
    )) {
      collected.push(
        String(
          (event as { choices?: Array<{ delta?: { content?: string } }> })
            .choices?.[0]?.delta?.content ?? '',
        ),
      )
    }
    expect(collected.join('')).toContain('就位')
  })
})
