import { describe, expect, mock, test } from 'bun:test'

import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/log.ts', logMock)

import type { DirectRoute } from '../../omniroute/adapter.js'
import {
  describeUpstreamFailure,
  retryDirectProviderStream,
} from '../openai/index.js'
import { NO_RESPONSE_REQUESTED } from '../../../utils/messages.js'

const ZERO_DELAY = (_ms: number, _signal: AbortSignal) => Promise.resolve()

function route(overrides: Partial<DirectRoute> = {}): DirectRoute {
  return {
    providerId: 'apisix',
    model: 'test-model',
    baseURL: 'https://gateway.test/v1',
    kind: 'custom',
    ...overrides,
  } as unknown as DirectRoute
}

describe('describeUpstreamFailure', () => {
  test('maps gateway_unavailable 502 to a precise, non-silent message', () => {
    const failure = describeUpstreamFailure({
      status: 502,
      message: '502 Bad Gateway all gateway backends unavailable',
    })
    expect(failure.error).toBe('server_error')
    expect(failure.content).toContain('Gateway is unavailable')
    expect(failure.content.startsWith('API Error')).toBe(true)
    expect(failure.content).not.toContain(NO_RESPONSE_REQUESTED)
  })

  test('maps gateway-wide 503 to the stable capacity message', () => {
    const failure = describeUpstreamFailure({
      status: 503,
      message: '503 upstream HTTP 503; all configured gateway backends failed',
    })
    expect(failure.error).toBe('server_error')
    expect(failure.content).toContain('Gateway is unavailable')
    expect(failure.content).not.toContain(
      'all configured gateway backends failed',
    )
  })

  test('classifies 429 as rate_limit', () => {
    const failure = describeUpstreamFailure({
      status: 429,
      message: 'rate limited',
    })
    expect(failure.error).toBe('rate_limit')
    expect(failure.content).toContain('rate limited')
    expect(failure.content).toContain('HTTP 429')
  })

  test('classifies 401/403 as authentication_failed', () => {
    const failure = describeUpstreamFailure({
      status: 401,
      message: 'Unauthorized: invalid api key',
    })
    expect(failure.error).toBe('authentication_failed')
    expect(failure.content).toContain('credentials rejected')
  })

  test('classifies timeouts as server_error with a timeout message', () => {
    const failure = describeUpstreamFailure({
      status: undefined,
      message: 'ETIMEDOUT: read timed out',
    })
    expect(failure.error).toBe('server_error')
    expect(failure.content).toContain('timed out')
  })

  test('reports the HTTP status and body for a bare 5xx', () => {
    const failure = describeUpstreamFailure({
      status: 500,
      message: 'Internal Server Error',
    })
    expect(failure.error).toBe('server_error')
    expect(failure.content).toContain('HTTP 500')
    expect(failure.content).toContain('Internal Server Error')
  })

  test('maps a real empty-stream provider output error as unusable output', async () => {
    let thrown: unknown
    try {
      const stream = retryDirectProviderStream(
        [route()],
        () =>
          Promise.resolve(
            (async function* () {
              yield* []
            })(),
          ),
        new AbortController().signal,
        undefined,
        false,
        ZERO_DELAY,
      )
      for await (const _event of stream) {
        // empty
      }
    } catch (error) {
      thrown = error
    }

    expect((thrown as Error).name).toBe('ProviderOutputError')
    expect((thrown as Error).message).toContain('returned an empty stream')
    const failure = describeUpstreamFailure(thrown)
    expect(failure.error).toBe('invalid_request')
    expect(failure.content).toContain('unusable output')
  })

  test('redacts bearer tokens from upstream text', () => {
    const secret = 'sk-live-9f81e3d2c4b5a67890abcdef'
    const failure = describeUpstreamFailure({
      status: 500,
      message: `500 while forwarding Authorization: Bearer ${secret}`,
    })
    expect(failure.content).not.toContain(secret)
    expect(failure.content).toContain('Bearer <redacted>')
  })

  test('caps untrusted upstream text so it cannot flood the transcript', () => {
    const failure = describeUpstreamFailure({
      status: 500,
      message: `500 ${'x'.repeat(2000)}`,
    })
    expect(failure.content.length).toBeLessThan(300)
  })

  test('treats an unexplained 4xx as unusable output', () => {
    const failure = describeUpstreamFailure({
      status: 418,
      message: 'unexpected upstream condition',
    })
    expect(failure.error).toBe('invalid_request')
    expect(failure.content).toContain('unusable output')
  })
})

describe('retryDirectProviderStream gateway failure', () => {
  test('rethrows the classified gateway error rather than a bare sentinel', async () => {
    let thrown: unknown
    try {
      const stream = retryDirectProviderStream(
        [route()],
        async () => {
          throw {
            status: 502,
            message: '502 Bad Gateway all gateway backends unavailable',
          }
        },
        new AbortController().signal,
        undefined,
        false,
        ZERO_DELAY,
      )
      for await (const _event of stream) {
        // exhausted
      }
    } catch (error) {
      thrown = error
    }
    expect((thrown as { status?: number }).status).toBe(502)
  })

  test('a bare 502 on a custom route is retried on its bounded budget', async () => {
    let attempts = 0
    try {
      const stream = retryDirectProviderStream(
        [route({ providerId: 'custom-bare-502' })],
        async () => {
          attempts++
          throw { status: 502, message: '502 Bad Gateway' }
        },
        new AbortController().signal,
        undefined,
        false,
        ZERO_DELAY,
      )
      for await (const _event of stream) {
        // drain
      }
    } catch {
      // exhausted
    }
    expect(attempts).toBe(3)
  })
})
