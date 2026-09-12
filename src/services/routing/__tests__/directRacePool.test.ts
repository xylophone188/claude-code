import { describe, expect, test } from 'bun:test'

import type { DirectRoute } from '../../omniroute/adapter.js'
import { buildDirectRacePool, selectRaceSpecs } from '../directRacePool.js'

const baseRoute: DirectRoute = {
  providerId: 'omniroute',
  baseURL: 'http://127.0.0.1:20128/v1',
  model: 'ccb-chat',
  apiKey: 'internal',
  kind: 'provider',
}

const overrides = {
  candidates: [
    'sensenova/deepseek-v4-flash',
    'oc/mimo-v2.5-free',
    'nvidia/deepseek-ai/deepseek-v4-pro-0813',
    'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/minimaxai/minimax-m3',
  ],
  freshOpenCodeModels: ['mimo-v2.5-free', 'ling-3.0-tiny-free', 'hy3-free'],
  nvidiaKeys: ['nvapi-a', 'nvapi-b'],
  nvidiaFallbackModel: 'minimaxai/minimax-m3',
  nvidiaDefaultCandidates: [],
}

describe('selectRaceSpecs', () => {
  test('caps opencode and nvidia at four models each', () => {
    const specs = selectRaceSpecs(
      [
        ...overrides.candidates,
        'nvidia/moonshotai/kimi-k3',
        'nvidia/deepseek-ai/deepseek-v4-flash-0731',
      ],
      overrides.freshOpenCodeModels,
    )
    const opencode = specs.filter(spec => spec.provider === 'opencode')
    expect(opencode.map(spec => spec.model)).toEqual([
      'mimo-v2.5-free',
      'ling-3.0-tiny-free',
      'hy3-free',
    ])
    const nvidia = specs.filter(spec => spec.provider === 'nvidia')
    expect(nvidia.map(spec => spec.model)).toEqual([
      'deepseek-ai/deepseek-v4-pro-0813',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'moonshotai/kimi-k3',
      'deepseek-ai/deepseek-v4-flash-0731',
    ])
  })

  test('merges built-in nvidia agent candidates and dedupes', () => {
    const specs = selectRaceSpecs(
      ['nvidia/deepseek-ai/deepseek-v4-pro-0813'],
      [],
      undefined,
      ['nvidia/deepseek-ai/deepseek-v4-pro-0813', 'nvidia/moonshotai/kimi-k3'],
    )
    expect(specs.map(spec => `${spec.provider}/${spec.model}`)).toEqual([
      'nvidia/deepseek-ai/deepseek-v4-pro-0813',
      'nvidia/moonshotai/kimi-k3',
    ])
  })

  test('stale or empty cache adds no guessed opencode model', () => {
    const specs = selectRaceSpecs(
      ['nvidia/deepseek-ai/deepseek-v4-flash-0731'],
      [],
    )
    expect(specs.filter(spec => spec.provider === 'opencode')).toEqual([])
    expect(specs.map(spec => spec.model)).toEqual([
      'deepseek-ai/deepseek-v4-flash-0731',
    ])
  })

  test('nvidia falls back to the provider default model when l1 has none', () => {
    const specs = selectRaceSpecs(
      ['oc/mimo-v2.5-free'],
      ['mimo-v2.5-free'],
      'deepseek-ai/deepseek-v4-flash-0731',
    )
    expect(
      specs.filter(spec => spec.provider === 'nvidia').map(spec => spec.model),
    ).toEqual(['deepseek-ai/deepseek-v4-flash-0731'])
  })

  test('never admits a non-generation provider such as gitee', () => {
    const specs = selectRaceSpecs(
      [
        'gitee/bge-m3',
        'gitee/bce-reranker-base-v1',
        'oc/mimo-v2.5-free',
        'nvidia/deepseek-ai/deepseek-v4-flash-0731',
      ],
      [],
      undefined,
      ['gitee/bge-m3'],
    )
    expect(specs.map(spec => `${spec.provider}/${spec.model}`)).toEqual([
      'opencode/mimo-v2.5-free',
      'nvidia/deepseek-ai/deepseek-v4-flash-0731',
    ])
  })
})

describe('buildDirectRacePool', () => {
  test('prepends capped race routes and demotes base routes to l2', () => {
    const pool = buildDirectRacePool([baseRoute], overrides)
    const l1 = pool.filter(route => route.tier === 'l1')
    expect(l1.length).toBe(5)
    expect(l1.every(route => route.race === true)).toBe(true)
    expect(
      l1.filter(route => route.kind === 'opencode').map(route => route.model),
    ).toEqual(['mimo-v2.5-free', 'ling-3.0-tiny-free', 'hy3-free'])
    expect(
      l1
        .filter(route => route.providerId === 'nvidia')
        .map(route => route.apiKey),
    ).toEqual(['nvapi-a', 'nvapi-b'])
    expect(pool[pool.length - 1]).toEqual({ ...baseRoute, tier: 'l2' })
  })

  test('empty base routes are returned unchanged', () => {
    expect(buildDirectRacePool([], overrides)).toEqual([])
  })

  test('no candidates and no nvidia keys keeps current behavior untouched', () => {
    const pool = buildDirectRacePool([baseRoute], {
      candidates: [],
      freshOpenCodeModels: [],
      nvidiaKeys: [],
    })
    expect(pool).toEqual([baseRoute])
  })

  test('nvidia routes round-robin across keys within the four-route cap', () => {
    const pool = buildDirectRacePool([baseRoute], {
      candidates: [
        'nvidia/deepseek-ai/deepseek-v4-pro-0813',
        'nvidia/moonshotai/kimi-k3',
        'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
        'nvidia/deepseek-ai/deepseek-v4-flash-0731',
      ],
      freshOpenCodeModels: [],
      nvidiaKeys: ['nvapi-a', 'nvapi-b', 'nvapi-c'],
      nvidiaDefaultCandidates: [],
    })
    const nvidia = pool.filter(route => route.providerId === 'nvidia')
    expect(nvidia.map(route => route.model)).toEqual([
      'deepseek-ai/deepseek-v4-pro-0813',
      'moonshotai/kimi-k3',
      'nvidia/nemotron-3-ultra-550b-a55b',
      'deepseek-ai/deepseek-v4-flash-0731',
    ])
    expect(nvidia.map(route => route.apiKey)).toEqual([
      'nvapi-a',
      'nvapi-b',
      'nvapi-c',
      'nvapi-a',
    ])
  })

  test('execution routes carry provider-specific request metadata', () => {
    const pool = buildDirectRacePool([baseRoute], overrides)
    const opencode = pool.filter(route => route.providerId === 'opencode')
    expect(opencode[0]).toMatchObject({
      baseURL: 'https://opencode.ai/zen/v1',
      model: 'mimo-v2.5-free',
      apiKey: 'public',
      kind: 'opencode',
      race: true,
      tier: 'l1',
    })
    const nvidia = pool.filter(route => route.providerId === 'nvidia')
    expect(nvidia[0]).toMatchObject({
      baseURL: 'https://integrate.api.nvidia.com/v1',
      model: 'deepseek-ai/deepseek-v4-pro-0813',
      apiKey: 'nvapi-a',
      race: true,
      tier: 'l1',
    })
  })
})
