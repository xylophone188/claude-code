import { afterEach, describe, expect, test } from 'bun:test'
import {
  buildGroups,
  getProviderModelGroups,
  isApisixModel,
  isGatewayModel,
  resetProviderModelGroupsCache,
} from '../opencodeFree.js'

describe('isGatewayModel', () => {
  test('routes provider-prefixed ids to the gateway', () => {
    expect(isGatewayModel('oc/deepseek-v4-flash-free')).toBe(true)
    expect(isGatewayModel('openrouter/gemini-3.5-flash-lite')).toBe(true)
    expect(isGatewayModel('cf/llama-4')).toBe(true)
    expect(isGatewayModel('github-models/gpt-5.6-sol')).toBe(true)
  })

  test('keeps opencode/* and openai/* on their curated paths', () => {
    expect(isGatewayModel('opencode/deepseek-v4-flash-free')).toBe(false)
    expect(isGatewayModel('openai/gpt-5.6-sol')).toBe(false)
  })

  test('bare gemini/grok ids count as gateway models', () => {
    expect(isGatewayModel('gemini-3.5-flash')).toBe(true)
    expect(isGatewayModel('grok-4-beta')).toBe(true)
    expect(isGatewayModel('claude-opus-4-5')).toBe(false)
  })

  test('apisix/* ids route to the gateway and are flagged apisix', () => {
    expect(isGatewayModel('apisix/auto/best-coding')).toBe(true)
    expect(isApisixModel('apisix/auto/best-coding')).toBe(true)
    expect(isApisixModel('APISIX/auto/best-reasoning')).toBe(true)
    expect(isApisixModel('openrouter/gemini-3.5-flash-lite')).toBe(false)
    expect(isApisixModel(null)).toBe(false)
  })
})

describe('buildGroups', () => {
  const ids = [
    'oc/deepseek-v4-flash-free',
    'oc/ling-3.0-flash-free',
    'oc/nemotron-3-ultra-free',
    'openai/gpt-5.6-sol',
    'openrouter/llama-4-maverick',
    'gemini-2.5-pro',
    'grok-4-beta',
    'anthropic-compatible-abc/claude-sonnet-4-5',
    'openai-compatible-chat-def/gpt-4o',
    'cf/llama-4-maverick',
    'unknown-prefix-xyz/foo',
    'oc/paid-model-x',
    'apisix/auto/best-coding',
  ]

  const groups = buildGroups(ids)

  test('oc group contains only free models with deepseek first', () => {
    const oc = groups.find(g => g.id === 'oc')
    expect(oc).toBeDefined()
    expect(oc!.models.length).toBe(3)
    expect(oc!.models[0]!.value).toBe('opencode/deepseek-v4-flash-free')
    // rest alphabetical by label
    const rest = oc!.models.slice(1).map(m => m.value)
    expect([...rest].sort()).toEqual(rest)
  })

  test('family keyword groups fold into anthropic/gemini/grok', () => {
    expect(groups.find(g => g.id === 'anthropic')).toBeDefined()
    expect(groups.find(g => g.id === 'gemini')).toBeDefined()
    expect(groups.find(g => g.id === 'grok')).toBeDefined()
  })

  test('openai/ ids are excluded from gateway grouping', () => {
    const openai = groups.find(g => g.id === 'openai')
    // openai-compatible-chat goes to openai group; bare openai/ is skipped
    expect(openai?.models.map(m => m.value)).toEqual([
      'openai-compatible-chat-def/gpt-4o',
    ])
  })

  test('known prefix groups and unknown prefixes fold into more', () => {
    const openrouter = groups.find(g => g.id === 'openrouter')
    expect(openrouter?.models[0]?.value).toBe('openrouter/llama-4-maverick')
    const more = groups.find(g => g.id === 'more')
    // paid oc/* models also land in more, not the free-only OpenCode group
    expect(more?.models.map(m => m.value)).toEqual([
      'unknown-prefix-xyz/foo',
      'oc/paid-model-x',
    ])
  })

  test('oc group always sorts first in result order', () => {
    expect(groups[0]!.id).toBe('oc')
  })

  test('apisix ids fold into the APISIX group', () => {
    const apisix = groups.find(g => g.id === 'apisix')
    expect(apisix).toBeDefined()
    expect(apisix!.label).toBe('APISIX')
    expect(apisix!.models.map(m => m.value)).toEqual([
      'apisix/auto/best-coding',
    ])
    const ocIdx = groups.findIndex(g => g.id === 'oc')
    const apisixIdx = groups.findIndex(g => g.id === 'apisix')
    expect(ocIdx).toBeLessThan(apisixIdx)
  })
})

describe('getProviderModelGroups resilience', () => {
  const prevBase = process.env.OPENCODE_FREE_BASE_URL

  afterEach(() => {
    if (prevBase === undefined) delete process.env.OPENCODE_FREE_BASE_URL
    else process.env.OPENCODE_FREE_BASE_URL = prevBase
    resetProviderModelGroupsCache()
  })

  // headroom is fetched via the curl CLI (its dozen-chunked responses break
  // node undici), so the gateway is forced "down" with an unreachable URL. The
  // APISIX source (9router, :20128) parses fine under undici and stays live.
  test('headroom down still surfaces APISIX group plus OpenCode fallback', async () => {
    process.env.OPENCODE_FREE_BASE_URL = 'http://127.0.0.1:59999'
    const groups = await getProviderModelGroups()
    expect(groups.some(g => g.id === 'apisix')).toBe(true)
    const oc = groups.find(g => g.id === 'oc')
    expect(oc?.models.map(m => m.value)).toEqual([
      'opencode/deepseek-v4-flash-free',
    ])
  })
})
