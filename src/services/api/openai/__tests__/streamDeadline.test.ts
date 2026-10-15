process.env.CCB_STREAM_FIRST_MEANINGFUL_TIMEOUT_MS = '50'
process.env.CCB_STREAM_ATTEMPT_TIMEOUT_MS = '200'
process.env.CCB_STREAM_INACTIVITY_TIMEOUT_MS = '50'
process.env.CCB_DIRECT_ROUTE_RETRIES = '1'

import { test, expect } from 'bun:test'
const { retryDirectProviderStream } = await import('../index.js')

type Route = Parameters<typeof retryDirectProviderStream>[0][number]
type Chunk =
  Awaited<
    ReturnType<Parameters<typeof retryDirectProviderStream>[1]>
  > extends AsyncIterable<infer T>
    ? T
    : never
const never = <T>(): Promise<T> => new Promise(() => {})
const delay = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))
const route = (name: string): Route => ({
  providerId: name,
  model: 'test',
  baseURL: 'https://fake.invalid',
  apiKey: 'fake',
  kind: 'provider',
})
const chunk = (
  id: string,
  delta: Record<string, unknown> = { role: 'assistant', content: 'OK' },
): Chunk =>
  ({
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: null }],
  }) as Chunk
const stream = (...chunks: Chunk[]): AsyncIterable<Chunk> => ({
  async *[Symbol.asyncIterator]() {
    yield* chunks
  },
})
async function collect(source: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const result: Chunk[] = []
  for await (const item of source) result.push(item)
  return result
}
function stuck(returnMode?: 'throw' | 'hang'): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => never<IteratorResult<Chunk>>(),
        return: () => {
          if (returnMode === 'throw') throw new Error('fake return failure')
          return never<IteratorResult<Chunk>>()
        },
      }
    },
  }
}

test('deadline: hanging create ignoring abort falls back', async () => {
  const routes = [route('create-hang-primary'), route('create-hang-backup')]
  const ok = chunk('create-hang-ok')
  const started = performance.now()
  const result = await collect(
    retryDirectProviderStream(
      routes,
      async r => (r === routes[0] ? never<AsyncIterable<Chunk>>() : stream(ok)),
      new AbortController().signal,
    ),
  )
  expect(result).toEqual([ok])
  expect(performance.now() - started).toBeLessThan(300)
})

test('deadline: headers followed by hanging next falls back', async () => {
  const routes = [route('headers-hang-primary'), route('headers-hang-backup')]
  const ok = chunk('headers-hang-ok')
  const started = performance.now()
  const result = await collect(
    retryDirectProviderStream(
      routes,
      async r => (r === routes[0] ? stuck() : stream(ok)),
      new AbortController().signal,
    ),
  )
  expect(result).toEqual([ok])
  expect(performance.now() - started).toBeLessThan(300)
})

test('deadline: partial tool chunks are discarded before fallback', async () => {
  const routes = [route('partial-tool-primary'), route('partial-tool-backup')]
  const partial = chunk('discarded-tool', {
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: 'call_partial',
        type: 'function',
        function: { name: 'fake', arguments: '{' },
      },
    ],
  })
  const ok = chunk('partial-tool-ok')
  const source: AsyncIterable<Chunk> = {
    [Symbol.asyncIterator]() {
      let first = true
      return {
        next: () => {
          if (first) {
            first = false
            return Promise.resolve({ value: partial, done: false as const })
          }
          return never<IteratorResult<Chunk>>()
        },
      }
    },
  }
  const started = performance.now()
  const result = await collect(
    retryDirectProviderStream(
      routes,
      async r => (r === routes[0] ? source : stream(ok)),
      new AbortController().signal,
    ),
  )
  expect(result).toEqual([ok])
  expect(performance.now() - started).toBeLessThan(300)
})

test('deadline: role-only every 10ms does not refresh first meaningful deadline', async () => {
  const routes = [route('role-only-primary'), route('role-only-backup')]
  const ok = chunk('role-only-ok')
  let primarySignal: AbortSignal | undefined
  let backupAt = 0
  const started = performance.now()
  const result = await collect(
    retryDirectProviderStream(
      routes,
      async (r, signal) => {
        if (r === routes[1]) {
          backupAt = performance.now() - started
          return stream(ok)
        }
        primarySignal = signal
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              await delay(10)
              yield chunk('role-only-discarded', { role: 'assistant' })
            }
          },
        }
      },
      new AbortController().signal,
    ),
  )
  expect(result).toEqual([ok])
  expect(primarySignal?.aborted).toBe(true)
  expect(backupAt).toBeLessThan(110)
  expect(performance.now() - started).toBeLessThan(300)
})

for (const phase of ['create', 'next'] as const) {
  test(`deadline: parent abort during ${phase} never invokes backup`, async () => {
    const routes = [
      route(`parent-${phase}-primary`),
      route(`parent-${phase}-backup`),
    ]
    const parent = new AbortController()
    let backupCalls = 0
    const started = performance.now()
    const timer = setTimeout(
      () => parent.abort(new Error(`fake parent ${phase} abort`)),
      10,
    )
    try {
      let failed = false
      try {
        await collect(
          retryDirectProviderStream(
            routes,
            async r => {
              if (r === routes[1]) {
                backupCalls++
                return stream(chunk(`parent-${phase}-unexpected`))
              }
              return phase === 'create'
                ? never<AsyncIterable<Chunk>>()
                : stuck()
            },
            parent.signal,
          ),
        )
      } catch {
        failed = true
      }
      expect(failed).toBe(true)
      expect(backupCalls).toBe(0)
      expect(performance.now() - started).toBeLessThan(300)
    } finally {
      clearTimeout(timer)
    }
  })
}

test('deadline: complete successful tool chunks remain intact', async () => {
  const routes = [route('complete-tool-primary'), route('complete-tool-backup')]
  const chunks = [
    chunk('complete-tool-1', {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call_complete',
          type: 'function',
          function: { name: 'fake', arguments: '{' },
        },
      ],
    }),
    chunk('complete-tool-2', {
      tool_calls: [{ index: 0, function: { arguments: '}' } }],
    }),
    {
      ...chunk('complete-tool-3', {}),
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    } as Chunk,
  ]
  let backupCalls = 0
  const result = await collect(
    retryDirectProviderStream(
      routes,
      async r => {
        if (r === routes[1]) backupCalls++
        return stream(...chunks)
      },
      new AbortController().signal,
    ),
  )
  expect(result).toEqual(chunks)
  expect(backupCalls).toBe(0)
})

for (const mode of ['throw', 'hang'] as const) {
  test(`deadline: iterator return ${mode} cannot prevent fallback`, async () => {
    const routes = [
      route(`return-${mode}-primary`),
      route(`return-${mode}-backup`),
    ]
    const ok = chunk(`return-${mode}-ok`)
    const started = performance.now()
    const result = await collect(
      retryDirectProviderStream(
        routes,
        async r => (r === routes[0] ? stuck(mode) : stream(ok)),
        new AbortController().signal,
      ),
    )
    expect(result).toEqual([ok])
    expect(performance.now() - started).toBeLessThan(300)
  })
}
