import { describe, expect, it } from 'bun:test'
import {
  classifyErrorStatus,
  getLastOmniRouteReceipt,
  parseOmniRouteReceipt,
  resetOmniRouteConfig,
  resolveDirectRoutes,
} from './adapter.js'

describe('classifyErrorStatus', () => {
  const CREDITS_EXHAUSTED =
    'All 5 connection(s) credits exhausted — reconnect in dashboard'

  it('classifies an exhausted-credit 401 as a rate limit, not auth', () => {
    expect(classifyErrorStatus(401, false, CREDITS_EXHAUSTED)).toBe(
      'rate_limit',
    )
  })

  it('classifies a quota-exhausted 401 as a rate limit', () => {
    expect(classifyErrorStatus(401, false, 'quota exhausted')).toBe(
      'rate_limit',
    )
  })

  it('keeps an invalid-key 401 as auth', () => {
    expect(classifyErrorStatus(401, false, 'invalid api key')).toBe('auth')
    expect(classifyErrorStatus(401)).toBe('auth')
  })

  it('keeps 429 as rate limit and aborts as transient', () => {
    expect(classifyErrorStatus(429)).toBe('rate_limit')
    expect(classifyErrorStatus(401, true, CREDITS_EXHAUSTED)).toBe('transient')
  })
})

describe('OmniRoute receipt', () => {
  it('routes ccb-main through the OmniRoute gateway', () => {
    const previousHeadroom = process.env.CCB_HEADROOM_BASE_URL
    const previous = process.env.OMNIROUTE_BASE_URL
    process.env.CCB_HEADROOM_BASE_URL = 'http://127.0.0.1:8787/v1'
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20131/v1'
    resetOmniRouteConfig()
    const routes = resolveDirectRoutes('ccb-main')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      providerId: 'omniroute',
      baseURL: 'http://127.0.0.1:8787/v1',
      model: 'auto/smart',
      headers: { 'x-omniroute-client': 'ccb' },
      kind: 'provider',
    })
    if (previous === undefined) delete process.env.OMNIROUTE_BASE_URL
    else process.env.OMNIROUTE_BASE_URL = previous
    if (previousHeadroom === undefined) delete process.env.CCB_HEADROOM_BASE_URL
    else process.env.CCB_HEADROOM_BASE_URL = previousHeadroom
    resetOmniRouteConfig()
  })

  it('parses routing and compression metadata without routing locally', () => {
    const receipt = parseOmniRouteReceipt(
      new Headers({
        'X-OmniRoute-Request-Id': 'req-1',
        'X-OmniRoute-Provider': 'glm',
        'X-OmniRoute-Model': 'z-ai/glm-5.2',
        'X-OmniRoute-Latency-Ms': '321',
        'X-OmniRoute-Fallback-Attempts': '2',
        'X-OmniRoute-Compression': 'gateway-cache',
        'X-OmniRoute-Decision': 'strategy=single; provider=glm',
      }),
    )
    expect(receipt).toEqual({
      requestId: 'req-1',
      provider: 'glm',
      model: 'z-ai/glm-5.2',
      latencyMs: 321,
      fallbackAttempts: 2,
      compression: 'gateway-cache',
      decision: 'strategy=single; provider=glm',
    })
    expect(getLastOmniRouteReceipt()).toEqual(receipt)
  })
})
