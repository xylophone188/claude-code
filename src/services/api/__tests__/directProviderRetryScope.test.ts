import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { retryDirectProviderStream } from '../openai/index.js'

beforeEach(() => {
  mock.restore()
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

describe('retryDirectProviderStream scope routing', () => {
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
      ),
    )
    expect(attempt).toBe(2)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect((chunks[0] as ChatCompletionChunk).model).toBe('glm-5.2')
  })
})
