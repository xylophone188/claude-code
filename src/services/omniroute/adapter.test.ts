import { describe, expect, it } from 'bun:test'
import {
  getLastOmniRouteReceipt,
  parseOmniRouteReceipt,
  resetOmniRouteConfig,
  resolveDirectRoutes,
} from './adapter.js'

describe('OmniRoute receipt', () => {
  it('routes hermes-score through the OmniRoute gateway', () => {
    const previous = process.env.OMNIROUTE_BASE_URL
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20131/v1'
    resetOmniRouteConfig()
    const routes = resolveDirectRoutes('hermes-score')
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({
      providerId: 'omniroute',
      model: 'auto/smart',
      kind: 'provider',
    })
    if (previous === undefined) delete process.env.OMNIROUTE_BASE_URL
    else process.env.OMNIROUTE_BASE_URL = previous
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
