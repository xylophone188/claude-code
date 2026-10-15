import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { DirectRoute } from '../../../omniroute/adapter.js'
import {
  DEDICATED_EXIT_DAILY_LIMIT,
  __resetDedicatedExitForTest,
  expandOpencodeFallbackRoutes,
  getDedicatedExitUsage,
  reserveDedicatedExitSlot,
} from '../opencodeFallbackChain.js'

const opencodeRoute: DirectRoute = {
  providerId: 'opencode',
  baseURL: 'https://opencode.ai/zen/v1',
  model: 'space-bunny-free',
  apiKey: 'public',
  kind: 'opencode',
}

const savedEnv = {
  baseURL: process.env.CCB_OPENCODE_DEDICATED_EXIT_BASE_URL,
  key: process.env.CCB_OPENCODE_DEDICATED_EXIT_KEY,
  model: process.env.CCB_OPENCODE_DEDICATED_EXIT_MODEL,
  limit: process.env.CCB_OPENCODE_DEDICATED_EXIT_LIMIT,
}

beforeEach(() => {
  __resetDedicatedExitForTest()
  process.env.CCB_OPENCODE_DEDICATED_EXIT_BASE_URL =
    'http://49.51.228.166:20131/v1/'
  process.env.CCB_OPENCODE_DEDICATED_EXIT_KEY = 'vps-dedicated-key'
  process.env.CCB_OPENCODE_DEDICATED_EXIT_MODEL = 'glm-5.2'
  delete process.env.CCB_OPENCODE_DEDICATED_EXIT_LIMIT
})

afterEach(() => {
  __resetDedicatedExitForTest()
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  restore('CCB_OPENCODE_DEDICATED_EXIT_BASE_URL', savedEnv.baseURL)
  restore('CCB_OPENCODE_DEDICATED_EXIT_KEY', savedEnv.key)
  restore('CCB_OPENCODE_DEDICATED_EXIT_MODEL', savedEnv.model)
  restore('CCB_OPENCODE_DEDICATED_EXIT_LIMIT', savedEnv.limit)
})

describe('opencode fallback chain', () => {
  test('default cap is 200 requests per day', () => {
    expect(DEDICATED_EXIT_DAILY_LIMIT).toBe(200)
    expect(getDedicatedExitUsage()).toEqual({
      used: 0,
      limit: 200,
      remaining: 200,
    })
  })

  test('reserves slots up to 200 then refuses', () => {
    for (let i = 0; i < 200; i++) expect(reserveDedicatedExitSlot()).toBe(true)
    expect(getDedicatedExitUsage()).toEqual({
      used: 200,
      limit: 200,
      remaining: 0,
    })
    expect(reserveDedicatedExitSlot()).toBe(false)
  })

  test('honors an explicit limit override', () => {
    process.env.CCB_OPENCODE_DEDICATED_EXIT_LIMIT = '3'
    expect(getDedicatedExitUsage().limit).toBe(3)
    expect(reserveDedicatedExitSlot()).toBe(true)
    expect(reserveDedicatedExitSlot()).toBe(true)
    expect(reserveDedicatedExitSlot()).toBe(true)
    expect(reserveDedicatedExitSlot()).toBe(false)
  })

  test('inserts the dedicated exit right after the opencode route', () => {
    const expanded = expandOpencodeFallbackRoutes([opencodeRoute])
    expect(expanded[0]?.providerId).toBe('opencode')
    const dedicated = expanded.find(
      route => route.providerId === 'opencode-dedicated',
    )
    expect(dedicated).toMatchObject({
      baseURL: 'http://49.51.228.166:20131/v1',
      model: 'glm-5.2',
      apiKey: 'vps-dedicated-key',
      kind: 'provider',
      tier: 'l2',
    })
  })

  test('falls back to the configured model when no override is set', () => {
    delete process.env.CCB_OPENCODE_DEDICATED_EXIT_MODEL
    const expanded = expandOpencodeFallbackRoutes([opencodeRoute])
    const dedicated = expanded.find(
      route => route.providerId === 'opencode-dedicated',
    )
    expect(dedicated?.model).toBe('space-bunny-free')
  })

  test('omits the dedicated exit but keeps NVIDIA when unconfigured', () => {
    delete process.env.CCB_OPENCODE_DEDICATED_EXIT_BASE_URL
    delete process.env.CCB_OPENCODE_DEDICATED_EXIT_KEY
    const expanded = expandOpencodeFallbackRoutes([opencodeRoute])
    expect(
      expanded.some(route => route.providerId === 'opencode-dedicated'),
    ).toBe(false)
    // NVIDIA NIM is the final degradation whenever its pool has accounts,
    // which is independent of the dedicated-exit configuration.
    expect(
      expanded.some(
        route =>
          route.providerId === 'nvidia' &&
          route.kind === 'provider' &&
          route.tier === 'l3',
      ),
    ).toBe(true)
  })

  test('inserts the fallbacks once, after the last opencode route', () => {
    const second: DirectRoute = { ...opencodeRoute, model: 'glm-5-free' }
    const expanded = expandOpencodeFallbackRoutes([opencodeRoute, second])
    expect(
      expanded.filter(route => route.providerId === 'opencode-dedicated')
        .length,
    ).toBe(1)
    const nvidia = expanded.filter(route => route.providerId === 'nvidia')
    expect(nvidia.length).toBeGreaterThan(0)
    const nvidiaKeys = new Set(
      nvidia.map(route => route.accountId ?? route.model),
    )
    expect(nvidiaKeys.size).toBe(nvidia.length)
    // Both public routes come first; the single fallback group trails them.
    expect(expanded[0]?.model).toBe('space-bunny-free')
    expect(expanded[1]?.model).toBe('glm-5-free')
    expect(expanded[2]?.providerId).toBe('opencode-dedicated')
  })

  test('leaves non-opencode routes in place', () => {
    const nvidiaRoute: DirectRoute = {
      providerId: 'nvidia',
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'z-ai/glm-5.2',
      apiKey: 'test',
      kind: 'provider',
    }
    const expanded = expandOpencodeFallbackRoutes([nvidiaRoute])
    expect(expanded).toEqual([nvidiaRoute])
  })

  test('handles an empty route list', () => {
    expect(expandOpencodeFallbackRoutes([])).toEqual([])
  })
})
