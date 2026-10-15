import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __clearClashCooldownForTest,
  __setClashRotationConfigForTest,
  fetchClashGroup,
  getClashRotationConfig,
  isClashRotatable429,
  markNodeCooldown,
  pickNextNode,
  putClashGroupNode,
  rotateClashNodeOn429,
} from '../clashNodeRotator.js'
import { retryDirectProviderStream } from '../index.js'
import type { DirectRoute } from '../../../omniroute/adapter.js'

interface FetchRecord {
  url: string
  method: string
  body: string | undefined
  headers: Record<string, string>
}

class FetchRecorder {
  private next: Response | ((rec: FetchRecord) => Response) = new Response('{}')
  readonly records: FetchRecord[] = []
  respond(r: Response | ((rec: FetchRecord) => Response)): void {
    this.next = r
  }
  fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = init.headers as Record<string, string>
      for (const k of Object.keys(h)) headers[k] = h[k]
    }
    const rec: FetchRecord = { url, method, body, headers }
    this.records.push(rec)
    const next = this.next
    return typeof next === 'function' ? next(rec) : next
  }
}

const originalFetch = globalThis.fetch
let recorder: FetchRecorder

beforeEach(() => {
  recorder = new FetchRecorder()
  globalThis.fetch = recorder.fetch as typeof globalThis.fetch
  __clearClashCooldownForTest()
  __setClashRotationConfigForTest({
    baseURL: 'http://127.0.0.1:9090',
    secret: undefined,
    groupName: '总模式',
    cooldownMs: 100,
    disabled: false,
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __clearClashCooldownForTest()
  __setClashRotationConfigForTest(null)
})

describe('isClashRotatable429', () => {
  test('429 alone is rotatable', () => {
    expect(isClashRotatable429(429, new Error('Too Many Requests'))).toBe(true)
  })

  test('undefined status is not rotatable', () => {
    expect(isClashRotatable429(undefined, new Error('boom'))).toBe(false)
  })

  test('403 with cloudflare message is rotatable', () => {
    expect(
      isClashRotatable429(
        403,
        new Error('cf-ray: 8ab1-XYZ; Sorry, you are not allowed'),
      ),
    ).toBe(true)
  })

  test('503 with 1020 error code is rotatable', () => {
    expect(isClashRotatable429(503, 'Error 1020: access denied')).toBe(true)
  })

  test('plain 500 is not rotatable', () => {
    expect(isClashRotatable429(500, new Error('server error'))).toBe(false)
  })

  test('403 without cloudflare markers is not rotatable', () => {
    expect(isClashRotatable429(403, new Error('forbidden'))).toBe(false)
  })
})

describe('pickNextNode', () => {
  const cfg = getClashRotationConfig()

  test('wraps around to first node', () => {
    const all = ['node-A', 'node-B', 'node-C']
    expect(pickNextNode(all, 'node-B', cfg)).toBe('node-C')
    expect(pickNextNode(all, 'node-C', cfg)).toBe('node-A')
  })

  test('skips non-rotatable pseudo-proxies', () => {
    const all = ['DIRECT', 'REJECT', '🌐 本机·本地直连', 'node-A', 'node-B']
    expect(pickNextNode(all, 'node-A', cfg)).toBe('node-B')
    expect(pickNextNode(all, undefined, cfg)).toBe('node-A')
  })

  test('returns null when all nodes are cooled', () => {
    const all = ['node-A', 'node-B']
    markNodeCooldown('node-A', 10_000)
    markNodeCooldown('node-B', 10_000)
    expect(pickNextNode(all, 'node-A', cfg)).toBeNull()
  })

  test('skips cooled nodes but uses others', () => {
    const all = ['node-A', 'node-B', 'node-C']
    markNodeCooldown('node-B', 10_000)
    // current = node-A, next would be node-B but it is cooled → node-C
    expect(pickNextNode(all, 'node-A', cfg)).toBe('node-C')
  })

  test('returns null for empty list', () => {
    expect(pickNextNode([], undefined, cfg)).toBeNull()
  })

  test('returns null when only non-rotatable nodes exist', () => {
    expect(pickNextNode(['DIRECT', 'REJECT'], undefined, cfg)).toBeNull()
  })
})

describe('fetchClashGroup', () => {
  test('GET /proxies/<group> with URL-encoded name', async () => {
    recorder.respond(
      new Response(
        JSON.stringify({
          name: '总模式',
          now: 'node-A',
          all: ['node-A', 'node-B'],
          type: 'Selector',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    const cfg = getClashRotationConfig()
    const group = await fetchClashGroup(cfg)
    expect(group?.now).toBe('node-A')
    expect(recorder.records[0]?.url).toBe(
      'http://127.0.0.1:9090/proxies/%E6%80%BB%E6%A8%A1%E5%BC%8F',
    )
    expect(recorder.records[0]?.method).toBe('GET')
  })

  test('returns null on non-200', async () => {
    recorder.respond(new Response('not found', { status: 404 }))
    const cfg = getClashRotationConfig()
    expect(await fetchClashGroup(cfg)).toBeNull()
  })

  test('sends bearer secret when configured', async () => {
    __setClashRotationConfigForTest({
      baseURL: 'http://127.0.0.1:9090',
      secret: 'hunter2',
      groupName: '总模式',
      cooldownMs: 100,
      disabled: false,
    })
    recorder.respond(
      new Response(
        JSON.stringify({
          name: '总模式',
          now: 'node-A',
          all: ['node-A', 'node-B'],
          type: 'Selector',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    await fetchClashGroup(getClashRotationConfig())
    expect(recorder.records[0]?.headers['Authorization']).toBe('Bearer hunter2')
  })
})

describe('putClashGroupNode', () => {
  test('PUT /proxies/<group> with body {name}', async () => {
    recorder.respond(new Response('ok'))
    const cfg = getClashRotationConfig()
    const ok = await putClashGroupNode(cfg, 'node-B')
    expect(ok).toBe(true)
    expect(recorder.records[0]?.method).toBe('PUT')
    expect(recorder.records[0]?.body).toBe(JSON.stringify({ name: 'node-B' }))
    expect(recorder.records[0]?.headers['Content-Type']).toBe(
      'application/json',
    )
  })

  test('returns false on non-2xx', async () => {
    recorder.respond(new Response('fail', { status: 500 }))
    const cfg = getClashRotationConfig()
    expect(await putClashGroupNode(cfg, 'node-B')).toBe(false)
  })
})

describe('rotateClashNodeOn429', () => {
  test('rotates from current to next and marks cooldown', async () => {
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A', 'node-B', 'node-C'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })
    const result = await rotateClashNodeOn429('test 429')
    expect(result.rotated).toBe(true)
    expect(result.previous).toBe('node-A')
    expect(result.next).toBe('node-B')
    expect(recorder.records[1]?.method).toBe('PUT')
    expect(recorder.records[1]?.body).toBe(JSON.stringify({ name: 'node-B' }))
  })

  test('skips cooled node and wraps around', async () => {
    // node-B cooled, current = node-A → next = node-C
    markNodeCooldown('node-B', 10_000)
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A', 'node-B', 'node-C'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })
    const result = await rotateClashNodeOn429('test 429')
    expect(result.next).toBe('node-C')
  })

  test('non-selector group is not rotated', async () => {
    recorder.respond(
      new Response(
        JSON.stringify({
          name: '总模式',
          now: 'node-A',
          all: ['node-A'],
          type: 'URLTest',
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    const result = await rotateClashNodeOn429('test 429')
    expect(result.rotated).toBe(false)
    expect(recorder.records).toHaveLength(1) // GET only, no PUT
  })

  test('returns not-rotated when disabled', async () => {
    __setClashRotationConfigForTest({ disabled: true })
    const result = await rotateClashNodeOn429('test 429')
    expect(result.rotated).toBe(false)
    expect(recorder.records).toHaveLength(0)
  })

  test('fail-open: network error returns not-rotated instead of throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const result = await rotateClashNodeOn429('test 429')
    expect(result.rotated).toBe(false)
  })

  test('marks the previous node as cooled', async () => {
    // After rotation, node-A must be cooled so the next rotation skips it.
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A', 'node-B'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })
    await rotateClashNodeOn429('test 429')
    // node-A was cooled. Next rotation should skip it.
    recorder.records.length = 0
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-B',
            all: ['node-A', 'node-B'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })
    const result = await rotateClashNodeOn429('test 429 again')
    // node-A is cooled, current is node-B → no rotatable next → not rotated
    expect(result.rotated).toBe(false)
    expect(result.previous).toBe('node-B')
  })
})

describe('retryDirectProviderStream triggers clash rotation on opencode 429', () => {
  const opencodeRoute: DirectRoute = {
    providerId: 'opencode',
    baseURL: 'https://opencode.test/v1',
    model: 'space-bunny-free',
    apiKey: 'public',
    kind: 'opencode',
  }

  test('429 on opencode route triggers rotateClashNodeOn429 then retries', async () => {
    // Mock fetch so rotateClashNodeOn429 has a working Clash controller.
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A', 'node-B'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })

    let attempts = 0
    const calls: string[] = []
    // Spy on rotateClashNodeOn429 by intercepting fetch calls to the clash
    // controller — the function is called internally by retryDirectProviderStream.
    const stream = retryDirectProviderStream(
      [opencodeRoute],
      async () => {
        attempts++
        if (attempts === 1) {
          const err = new Error('HTTP 429 Too Many Requests') as Error & {
            status?: number
          }
          err.status = 429
          throw err
        }
        calls.push(`attempt-${attempts}`)
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'test',
              choices: [
                { delta: { content: 'ok' }, finish_reason: null, index: 0 },
              ],
              created: 0,
              model: 'test',
              object: 'chat.completion.chunk',
            } as never
          },
        }
      },
      new AbortController().signal,
    )
    const events = await Array.fromAsync(stream)
    expect(attempts).toBe(2) // 1st failed with 429, 2nd succeeded
    expect(events).toHaveLength(1)
    // Verify Clash controller was queried (GET) and a PUT rotation happened.
    const methods = recorder.records.map(r => r.method)
    expect(methods).toContain('GET')
    expect(methods).toContain('PUT')
    // The PUT body should target the next node, not the cooled current.
    const putBody = recorder.records.find(r => r.method === 'PUT')?.body
    expect(putBody).toBe(JSON.stringify({ name: 'node-B' }))
    expect(calls).toEqual(['attempt-2'])
  })

  test('non-429 error on opencode route does not trigger clash rotation', async () => {
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A', 'node-B'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })

    let attempts = 0
    const stream = retryDirectProviderStream(
      [opencodeRoute],
      async () => {
        attempts++
        if (attempts <= 2) {
          const err = new Error('HTTP 500 server error') as Error & {
            status?: number
          }
          err.status = 500
          throw err
        }
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'test',
              choices: [
                { delta: { content: 'ok' }, finish_reason: null, index: 0 },
              ],
              created: 0,
              model: 'test',
              object: 'chat.completion.chunk',
            } as never
          },
        }
      },
      new AbortController().signal,
    )
    await Array.fromAsync(stream)
    // 500 is not rotatable: no GET/PUT to clash controller expected.
    const methods = recorder.records.map(r => r.method)
    expect(methods).not.toContain('GET')
    expect(methods).not.toContain('PUT')
  })

  test('exhausted clash pool leaves opencode without burning retries', async () => {
    // Every node is cooled, so pickNextNode returns null and rotation reports
    // rotated: false. The opencode route must then be abandoned immediately.
    markNodeCooldown('node-A', 10_000)
    recorder.respond(rec => {
      if (rec.method === 'GET')
        return new Response(
          JSON.stringify({
            name: '总模式',
            now: 'node-A',
            all: ['node-A'],
            type: 'Selector',
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('ok')
    })

    let attempts = 0
    const stream = retryDirectProviderStream(
      [opencodeRoute],
      async () => {
        attempts++
        const err = new Error('HTTP 429 Too Many Requests') as Error & {
          status?: number
        }
        err.status = 429
        throw err
      },
      new AbortController().signal,
    )
    await Array.fromAsync(stream).catch(() => [])
    // One attempt only: DIRECT_ROUTE_RETRIES is 11, so exiting early proves
    // the pool-exhaustion break fired.
    expect(attempts).toBe(1)
  })
})
