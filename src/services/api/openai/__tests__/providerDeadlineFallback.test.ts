process.env.CCB_STREAM_FIRST_MEANINGFUL_TIMEOUT_MS = '50'
process.env.CCB_STREAM_ATTEMPT_TIMEOUT_MS = '200'
process.env.CCB_STREAM_INACTIVITY_TIMEOUT_MS = '50'
process.env.CCB_DIRECT_ROUTE_RETRIES = '1'

import { test, expect } from 'bun:test'
const { retryDirectProviderStream } = await import('../index.js')

test('provider deadline skips current model and continues to backup route', async () => {
  const routes = [
    {
      providerId: 'fixture-down',
      model: 'down-1',
      baseURL: 'http://fixture.invalid',
      apiKey: 'fake',
      kind: 'provider',
    },
    {
      providerId: 'fixture-down',
      model: 'down-2',
      baseURL: 'http://fixture.invalid',
      apiKey: 'fake',
      kind: 'provider',
    },
    {
      providerId: 'fixture-down',
      model: 'down-3',
      baseURL: 'http://fixture.invalid',
      apiKey: 'fake',
      kind: 'provider',
    },
    {
      providerId: 'fixture-backup',
      model: 'backup',
      baseURL: 'http://fixture.invalid',
      apiKey: 'fake',
      kind: 'provider',
    },
  ]
  const calls: Array<{
    providerId: string
    model: string
    signal: AbortSignal
  }> = []
  const createStream = async (
    route: (typeof routes)[number],
    signal: AbortSignal,
  ) => {
    calls.push({ providerId: route.providerId, model: route.model, signal })
    if (route.providerId === 'fixture-down') {
      return await new Promise<never>(() => {})
    }
    return (async function* () {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: route.model,
        choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
      }
    })()
  }
  const started = performance.now()
  const result = []
  for await (const chunk of retryDirectProviderStream(
    routes as never,
    createStream as never,
    new AbortController().signal,
  )) {
    result.push(chunk)
  }
  expect(performance.now() - started).toBeLessThan(500)
  expect(calls).toHaveLength(4)
  expect(calls.map(({ providerId, model }) => ({ providerId, model }))).toEqual(
    [
      { providerId: 'fixture-down', model: 'down-1' },
      { providerId: 'fixture-down', model: 'down-2' },
      { providerId: 'fixture-down', model: 'down-3' },
      { providerId: 'fixture-backup', model: 'backup' },
    ],
  )
  expect(calls[0]!.signal.aborted).toBe(true)
  expect(result).toEqual([
    {
      id: 'chunk-1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'backup',
      choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }],
    },
  ])
})

test('retries transient deadline timeout when attempts > 1 before failing model', async () => {
  process.env.CCB_DIRECT_ROUTE_RETRIES = '2'
  const routes = [
    {
      providerId: 'fixture-retry',
      model: 'retry-model',
      baseURL: 'http://fixture.invalid',
      apiKey: 'fake',
      kind: 'provider' as const,
    },
  ]
  let attempts = 0
  const createStream = async () => {
    attempts++
    if (attempts === 1) {
      return await new Promise<never>(() => {})
    }
    return (async function* () {
      yield {
        id: 'chunk-ok',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'retry-model',
        choices: [
          { index: 0, delta: { content: 'SUCCESS' }, finish_reason: null },
        ],
      }
    })()
  }

  const result = []
  for await (const chunk of retryDirectProviderStream(
    routes as never,
    createStream as never,
    new AbortController().signal,
  )) {
    result.push(chunk)
  }

  expect(attempts).toBe(2)
  expect(result).toHaveLength(1)
  expect((result[0] as any).choices[0].delta.content).toBe('SUCCESS')
})
