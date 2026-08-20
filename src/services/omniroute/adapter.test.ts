import { describe, expect, it } from 'bun:test'
import { getLastOmniRouteReceipt, parseOmniRouteReceipt } from './adapter.js'

describe('OmniRoute receipt', () => {
  it('parses routing and compression metadata without routing locally', () => {
    const receipt = parseOmniRouteReceipt(
      new Headers({
        'X-OmniRoute-Request-Id': 'req-1',
        'X-OmniRoute-Provider': 'glm',
        'X-OmniRoute-Model': 'z-ai/glm-5.2',
        'X-OmniRoute-Latency-Ms': '321',
        'X-OmniRoute-Fallback-Attempts': '2',
        'X-OmniRoute-Compression': 'gateway-cache',
      }),
    )
    expect(receipt).toEqual({
      requestId: 'req-1',
      provider: 'glm',
      model: 'z-ai/glm-5.2',
      latencyMs: 321,
      fallbackAttempts: 2,
      compression: 'gateway-cache',
    })
    expect(getLastOmniRouteReceipt()).toEqual(receipt)
  })
})
