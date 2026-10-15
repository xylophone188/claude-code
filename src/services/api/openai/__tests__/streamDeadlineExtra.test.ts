process.env.CCB_STREAM_FIRST_MEANINGFUL_TIMEOUT_MS = '50'
process.env.CCB_STREAM_ATTEMPT_TIMEOUT_MS = '200'
process.env.CCB_STREAM_INACTIVITY_TIMEOUT_MS = '50'
process.env.CCB_DIRECT_ROUTE_RETRIES = '1'

import { test, expect } from 'bun:test'
import { getEventListeners } from 'node:events'
const {
  retryDirectProviderStream,
  retryTierDirectProviderStream,
  raceDirectProviderStream,
} = await import('../index.js')

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const never = () => new Promise<any>(() => {})
let serial = 0
const route = () => ({
  providerId: `deadline-extra-${++serial}`,
  model: 'test',
  baseURL: 'http://fixture.invalid',
  apiKey: 'fake',
  kind: 'provider',
})
const chunk = () => ({
  id: 'fixture',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'test',
  choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }],
})
const hanging = (first = false, onReturn = () => {}) => ({
  [Symbol.asyncIterator]() {
    return this
  },
  next: first
    ? (() => {
        let sent = false
        return () =>
          sent
            ? never()
            : ((sent = true), Promise.resolve({ done: false, value: chunk() }))
      })()
    : never,
  return: async () => {
    onReturn()
    return { done: true, value: undefined }
  },
})
const fallback = () => ({
  async *[Symbol.asyncIterator]() {
    yield chunk()
  },
})
const invoke = (fn: any, options: any) =>
  fn === retryTierDirectProviderStream
    ? fn(
        options.routes,
        140,
        options.createStream,
        options.signal ?? new AbortController().signal,
      )
    : fn(
        options.routes,
        options.createStream,
        options.signal ?? new AbortController().signal,
      )
const drain = async (stream: any) => {
  for await (const _ of stream) {
  }
}

test('create time is included in first meaningful deadline', async () => {
  const started = performance.now()
  let fallbackAt = 0
  await drain(
    invoke(retryDirectProviderStream, {
      routes: [route(), route()],
      createStream: async (_route: any) => {
        if (!fallbackAt && performance.now() - started < 20) {
          await sleep(25)
          return hanging()
        }
        fallbackAt = performance.now() - started
        return fallback()
      },
    }),
  )
  expect(fallbackAt).toBeGreaterThan(0)
  expect(fallbackAt).toBeLessThan(80)
}, 3000)

test('meaningful chunks cannot extend total attempt deadline', async () => {
  let calls = 0
  const started = performance.now()
  await drain(
    invoke(retryDirectProviderStream, {
      routes: [route(), route()],
      createStream: async () =>
        ++calls === 1
          ? {
              async *[Symbol.asyncIterator]() {
                while (true) {
                  await sleep(10)
                  yield chunk()
                }
              },
            }
          : fallback(),
    }),
  )
  expect(calls).toBe(2)
  expect(performance.now() - started).toBeLessThan(300)
}, 3000)

test('late create resolution closes timed out stream', async () => {
  let calls = 0
  let returned = false
  await drain(
    invoke(retryDirectProviderStream, {
      routes: [route(), route()],
      createStream: async () => {
        if (++calls !== 1) return fallback()
        await sleep(75)
        return hanging(false, () => {
          returned = true
        })
      },
    }),
  )
  await sleep(80)
  expect(returned).toBe(true)
}, 3000)

test('parent abort listeners are removed on success timeout and abort', async () => {
  for (const mode of ['success', 'timeout', 'abort']) {
    const parent = new AbortController()
    const timer =
      mode === 'abort' ? setTimeout(() => parent.abort(), 15) : undefined
    try {
      await drain(
        invoke(retryDirectProviderStream, {
          routes: [route()],
          signal: parent.signal,
          createStream: async () =>
            mode === 'success' ? fallback() : hanging(),
        }),
      )
    } catch (error) {
      if (mode === 'success') throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  }
}, 3000)

test('tier forwards inner signal and falls back after first chunk stalls', async () => {
  let calls = 0
  let forwarded: any
  await drain(
    invoke(retryTierDirectProviderStream, {
      routes: [route(), route()],
      createStream: async (_route: any, innerSignal: any) => {
        forwarded = innerSignal
        return ++calls === 1 ? hanging(true) : fallback()
      },
    }),
  )
  expect(calls).toBe(2)
  expect(forwarded).toBeInstanceOf(AbortSignal)
}, 3000)

test('race winner stalled after first chunk fails next without fallback', async () => {
  let calls = 0
  const started = performance.now()
  const stream = invoke(raceDirectProviderStream, {
    routes: [route(), route()],
    createStream: async () => (++calls === 1 ? hanging(true) : never()),
  })
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  let failure: unknown
  try {
    await iterator.next()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect(calls).toBeLessThanOrEqual(2)
  expect(performance.now() - started).toBeLessThan(300)
}, 3000)
