import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// getProviderList() resolves the OpenAI count via a dynamic import of
// modelOptions.js, whose real module graph (auth.js etc.) is mocked by other
// test files (e.g. effort.test.ts) — co-running them then explodes with
// "Export named ... not found". Stub the module so this file is self-contained.
mock.module('src/utils/model/modelOptions.js', () => ({
  getChatGPTCodexModelOptions: () => [
    { value: null, label: 'Default (recommended)', description: 'default' },
  ],
}))
import {
  buildGroups,
  buildProviderCatalog,
  buildSubproviders,
  filterModelsByProvider,
  getProviderContent,
  getProviderList,
  getProviderModelGroups,
  isCCBModel,
  isGatewayModel,
  resetProviderModelGroupsCache,
} from '../opencodeFree.js'
import {
  addRegisteredProvider,
  getLocalGatewayName,
  getRegisteredProviders,
  removeRegisteredProvider,
  setLocalGatewayName,
} from '../providerRegistry.js'

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

  test('ccb/* ids route to the gateway and are flagged ccb', () => {
    expect(isGatewayModel('ccb/auto/best-coding')).toBe(true)
    expect(isCCBModel('ccb/auto/best-coding')).toBe(true)
    expect(isCCBModel('CCB/auto/best-reasoning')).toBe(true)
    expect(isCCBModel('openrouter/gemini-3.5-flash-lite')).toBe(false)
    expect(isCCBModel(null)).toBe(false)
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
    'ccb/auto/best-coding',
  ]

  const groups = buildGroups(ids)

  test('oc group contains only free models', () => {
    const oc = groups.find(g => g.id === 'oc')
    expect(oc).toBeDefined()
    expect(oc!.models.map(m => m.value)).toEqual([
      'opencode/deepseek-v4-flash-free',
      'opencode/ling-3.0-flash-free',
      'opencode/nemotron-3-ultra-free',
    ])
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

  test('ccb ids fold into the CCB group', () => {
    const ccb = groups.find(g => g.id === 'ccb')
    expect(ccb).toBeDefined()
    expect(ccb!.label).toBe('CCB')
    expect(ccb!.models.map(m => m.value)).toEqual(['ccb/auto/best-coding'])
    const ocIdx = groups.findIndex(g => g.id === 'oc')
    const ccbIdx = groups.findIndex(g => g.id === 'ccb')
    expect(ocIdx).toBeLessThan(ccbIdx)
  })
})

describe('getProviderModelGroups resilience', () => {
  const prevBase = process.env.OPENCODE_FREE_BASE_URL
<<<<<<< Updated upstream
<<<<<<< Updated upstream
  const prevCache = process.env.CCB_OPENCODE_MODELS_CACHE_FILE
=======
  const prevHome = process.env.HOME
  const prevCacheFile = process.env.CCB_OPENCODE_MODELS_CACHE_FILE
>>>>>>> Stashed changes
=======
  const prevHome = process.env.HOME
  const prevCacheFile = process.env.CCB_OPENCODE_MODELS_CACHE_FILE
>>>>>>> Stashed changes
  const realFetch = globalThis.fetch
  let dir: string

  beforeEach(() => {
<<<<<<< Updated upstream
<<<<<<< Updated upstream
    // Point the cache reader at a non-existent file so the real
    // ~/.ccb-embed/opencode-free-models.json cannot leak fresh models in.
    process.env.CCB_OPENCODE_MODELS_CACHE_FILE =
      '/nonexistent-ccb-oc-cache.json'
=======
=======
>>>>>>> Stashed changes
    dir = mkdtempSync(join(tmpdir(), 'ccb-groups-'))
    process.env.HOME = dir
    const cacheFile = join(dir, '.ccb-embed', 'opencode-free-models.json')
    mkdirSync(join(dir, '.ccb-embed'), { recursive: true })
    process.env.CCB_OPENCODE_MODELS_CACHE_FILE = cacheFile
    // Deterministic dynamic free-model cache inside the 8h TTL window.
    writeFileSync(
      cacheFile,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        models: ['mimo-v2.5-free', 'ling-3.0-flash-fin-free'],
      }),
    )
<<<<<<< Updated upstream
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
    // Deterministic stub: the local gateway's /api/v1/models can take >15s
    // live, which blows up the 5s default test timeout. The stub keeps the
    // test's point (direct CCB fetch still
    // surfaces) without depending on the live gateway's latency.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'kimi/kimi-k2.5-thinking' }] }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    if (prevBase === undefined) delete process.env.OPENCODE_FREE_BASE_URL
    else process.env.OPENCODE_FREE_BASE_URL = prevBase
<<<<<<< Updated upstream
<<<<<<< Updated upstream
    if (prevCache === undefined)
      delete process.env.CCB_OPENCODE_MODELS_CACHE_FILE
    else process.env.CCB_OPENCODE_MODELS_CACHE_FILE = prevCache
    resetProviderModelGroupsCache()
  })

  // The old dynamic catalog is unavailable in this standalone build; the
  // node undici), so the gateway is forced "down" with an unreachable URL. The
  // CCB source is fetched via undici (stubbed above) and stays live.
  test('direct catalog surfaces CCB group but no OpenCode models when cache unavailable', async () => {
    process.env.OPENCODE_FREE_BASE_URL = 'http://127.0.0.1:59999'
    const groups = await getProviderModelGroups()
    expect(groups.some(g => g.id === 'ccb')).toBe(true)
    // When cache is unavailable (gateway down, no valid cache), no OpenCode
    // models may be fabricated in any group.
    const allValues = groups.flatMap(g => g.models.map(m => m.value ?? ''))
    expect(allValues.filter(v => v.startsWith('opencode/'))).toEqual([])
=======
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevCacheFile === undefined)
      delete process.env.CCB_OPENCODE_MODELS_CACHE_FILE
    else process.env.CCB_OPENCODE_MODELS_CACHE_FILE = prevCacheFile
    resetProviderModelGroupsCache()
  })

=======
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevCacheFile === undefined)
      delete process.env.CCB_OPENCODE_MODELS_CACHE_FILE
    else process.env.CCB_OPENCODE_MODELS_CACHE_FILE = prevCacheFile
    resetProviderModelGroupsCache()
  })

>>>>>>> Stashed changes
  // The gateway is forced "down" with an unreachable URL. The CCB source is
  // fetched via undici (stubbed above) and stays live.
  test('direct catalog still surfaces CCB group plus OpenCode fallback', async () => {
    process.env.OPENCODE_FREE_BASE_URL = 'http://127.0.0.1:59999'
    const groups = await getProviderModelGroups()
    expect(groups.some(g => g.id === 'ccb')).toBe(true)
    const oc = groups.find(g => g.id === 'oc')
    expect(oc?.models.map(m => m.value)).toEqual([
      'opencode/ling-3.0-flash-fin-free',
      'opencode/mimo-v2.5-free',
    ])
>>>>>>> Stashed changes
  })
})

describe('providerRegistry (HOME mocked)', () => {
  const prevHome = process.env.HOME
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccb-registry-'))
    process.env.HOME = dir
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
  })

  test('empty when registry file missing', () => {
    expect(getRegisteredProviders()).toEqual([])
  })

  test('add is idempotent per providerId and persists', () => {
    const first = addRegisteredProvider({ providerId: 'kiro', name: 'Kiro' })
    expect(first).toHaveLength(1)
    expect(first[0]!.providerId).toBe('kiro')
    expect(first[0]!.name).toBe('Kiro')
    expect(first[0]!.id).toBeTruthy()
    expect(first[0]!.addedAt).toBeTruthy()

    const dup = addRegisteredProvider({ providerId: 'kiro', name: 'Kiro2' })
    expect(dup).toHaveLength(1)
    expect(dup[0]!.name).toBe('Kiro')

    // survives reload
    expect(getRegisteredProviders()).toHaveLength(1)
  })

  test('remove drops the entry', () => {
    const [entry] = addRegisteredProvider({ providerId: 'groq', name: 'Groq' })
    removeRegisteredProvider(entry!.id)
    expect(getRegisteredProviders()).toEqual([])
  })

  test('local gateway name defaults and can be set', () => {
    expect(getLocalGatewayName()).toBe('本地供应商')
    setLocalGatewayName('我的网关')
    expect(getLocalGatewayName()).toBe('我的网关')
    const [entry] = getRegisteredProviders()
    expect(entry!.providerId).toBe('ccb')
    setLocalGatewayName('改名')
    expect(getLocalGatewayName()).toBe('改名')
    expect(getRegisteredProviders()).toHaveLength(1)
  })

  test('corrupt registry degrades to empty', () => {
    mkdirSync(join(dir, '.ccb'), { recursive: true })
    writeFileSync(join(dir, '.ccb', 'providers.json'), 'not json{')
    expect(getRegisteredProviders()).toEqual([])
  })
})

describe('pure provider helpers', () => {
  test('filterModelsByProvider matches first segment and dedups', () => {
    const ids = [
      'kimi/kimi-k2.5-thinking',
      'kimi/kimi-k2.5-thinking',
      'kimiko/other',
      'groq/g1',
    ]
    expect(filterModelsByProvider(ids, 'kimi')).toEqual([
      'kimi/kimi-k2.5-thinking',
    ])
    expect(filterModelsByProvider(ids, 'groq')).toEqual(['groq/g1'])
    expect(filterModelsByProvider(ids, 'nope')).toEqual([])
  })

  test('buildSubproviders groups counts, friendly labels, alpha order', () => {
    const ids = ['kimi/k1', 'kimi/k2', 'groq/g1', 'unknown-prefix-xyz/foo']
    expect(buildSubproviders(ids)).toEqual([
      { value: 'groq', label: 'Groq', description: '1 model' },
      { value: 'kimi', label: 'Kimi', description: '2 models' },
      {
        value: 'unknown-prefix-xyz',
        label: 'unknown-prefix-xyz',
        description: '1 model',
      },
    ])
  })

  test('buildProviderCatalog leads with local gateway, dedups segments', () => {
    const ids = [
      'kimi/k1',
      'kimi/k2',
      'groq/g1',
      'ccb/something',
      'unknown-prefix-xyz/foo',
    ]
    const catalog = buildProviderCatalog(ids)
    expect(catalog[0]?.value).toBe('ccb')
    expect(catalog.map(o => o.value)).toEqual([
      'ccb',
      'groq',
      'kimi',
      'unknown-prefix-xyz',
    ])
    expect(catalog[2]).toMatchObject({ value: 'kimi', label: 'Kimi' })
  })
})

describe('getProviderList / getProviderContent with stubbed gateway', () => {
  const prevHome = process.env.HOME
  const prevRouting = process.env.OMNIROUTE_SERVER_ROUTING
  let dir: string
  const realFetch = globalThis.fetch

  const stubGateway = (combos: unknown[], models: unknown[]) => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/v1/combos')) {
        return new Response(JSON.stringify({ data: combos }), { status: 200 })
      }
      return new Response(JSON.stringify({ data: models }), { status: 200 })
    }) as typeof fetch
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccb-home-'))
    process.env.HOME = dir
    resetProviderModelGroupsCache()
    // These tests exercise the full model picker; disable OmniRoute server
    // routing so the single-entry auto collapse does not hide it.
    process.env.OMNIROUTE_SERVER_ROUTING = '0'
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    rmSync(dir, { recursive: true, force: true })
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    if (prevRouting === undefined) delete process.env.OMNIROUTE_SERVER_ROUTING
    else process.env.OMNIROUTE_SERVER_ROUTING = prevRouting
  })

  test('gateway down: default, switch, add, delete', async () => {
    stubGateway([], [])
    const list = await getProviderList()
    expect(list.map(o => o.value)).toEqual([
      'auto',
      'default',
      'switch',
      'add-provider',
      'delete-provider',
    ])
  })

  test('codex login shows codex models in default content', async () => {
    stubGateway([], [])
    mkdirSync(join(dir, '.codex'), { recursive: true })
    writeFileSync(
      join(dir, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: 'x' } }),
    )
    const list = await getProviderList()
    expect(list.map(o => o.value)).toEqual([
      'auto',
      'default',
      'switch',
      'add-provider',
      'delete-provider',
    ])
    const content = await getProviderContent('default')
    expect(content.kind).toBe('models')
    expect(content.options.length).toBeGreaterThan(0)
  })

  test('gateway content via switch shows providers', async () => {
    stubGateway([{ name: 'routeha' }], [])
    setLocalGatewayName('我的网关')
    const content = await getProviderContent('switch')
    expect(content.kind).toBe('subproviders')
    expect(content.options.length).toBeGreaterThan(0)
  })

  test('switch provider shows registered providers', async () => {
    stubGateway([{ name: 'routeha' }], [])
    addRegisteredProvider({ providerId: 'kiro', name: 'Kiro' })
    const content = await getProviderContent('switch')
    expect(content.kind).toBe('subproviders')
    expect(content.options.some(o => o.value === 'kiro')).toBe(true)
  })

  test('ccb content lists direct providers plus the OmniRoute gateway', async () => {
    stubGateway(
      [
        { name: 'routeha' },
        { name: 'default-free' },
        { name: 'e2e-auto-test-1' },
      ],
      [],
    )
    const content = await getProviderContent('ccb')
    expect(content.kind).toBe('subproviders')
    expect(content.options.length).toBeGreaterThan(0)
    expect(content.options.some(o => o.value === 'omniroute')).toBe(true)
  })

  test('ccb content: no combos falls back to subproviders', async () => {
    stubGateway(
      [],
      [
        { id: 'kimi/kimi-k2.5-thinking', owned_by: 'model' },
        { id: 'kimi/kimi-k2.5-reasoning', owned_by: 'model' },
        { id: 'groq/g1', owned_by: 'model' },
        { id: 'auto/best-coding', owned_by: 'combo' },
      ],
    )
    const content = await getProviderContent('ccb')
    expect(content.kind).toBe('subproviders')
    expect(content.options.length).toBeGreaterThan(0)
  })

  test('kimi content exposes CCB direct models under the ccb/kimi namespace', async () => {
    stubGateway(
      [],
      [
        { id: 'kimi/kimi-k2.5-thinking', owned_by: 'model' },
        { id: 'auto/best-coding', owned_by: 'combo' },
      ],
    )
    const content = await getProviderContent('kimi')
    expect(content.kind).toBe('models')
    expect(content.options.length).toBeGreaterThan(0)
    expect(
      content.options.every(o => (o.value ?? '').startsWith('ccb/kimi/')),
    ).toBe(true)
  })

  test('auto content exposes automatic and explicit CX model choices', async () => {
    stubGateway([], [])
    const content = await getProviderContent('auto')
    expect(content.kind).toBe('models')
    expect(content.options.map(option => option.value)).toEqual([
      'hermes-score',
      'cx/gpt-5.6-luna',
      'cx/gpt-5.6-terra',
      'cx/gpt-5.6-sol',
    ])
    expect(content.lines).toBeDefined()
    const lines = content.lines!
    expect(lines[0]).toContain('候选池')
  })
})
