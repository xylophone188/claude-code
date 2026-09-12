import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildOmniRouteRequestHeaders,
  chooseAccounts,
  classifyErrorStatus,
  getActiveCcbRoute,
  getLastOmniRouteReceipt,
  parseOmniRouteReceipt,
  resetOmniRouteConfig,
  resolveDirectRoutes,
  setActiveCcbRoute,
} from './adapter.js'
import { _invalidateProviderCache } from '../providerRegistry/loader.js'
import type { ProviderConfig } from '../providerRegistry/types.js'

interface RouteEnvironment {
  [name: string]: string | undefined
}

function restoreRouteEnv(previous: RouteEnvironment): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  resetOmniRouteConfig()
}

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
  it('routes ccb-main through the preferred OmniRoute ingress', () => {
    const previous = {
      CCB_HEADROOM_BASE_URL: process.env.CCB_HEADROOM_BASE_URL,
      CCB_ROUTE_NAME: process.env.CCB_ROUTE_NAME,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
    }
    process.env.CCB_HEADROOM_BASE_URL = 'http://127.0.0.1:8787/v1'
    process.env.CCB_ROUTE_NAME = 'custom-ccb-route'
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20131/v1'
    resetOmniRouteConfig()
    try {
      expect(resolveDirectRoutes('ccb-main')).toEqual([
        expect.objectContaining({
          providerId: 'omniroute',
          baseURL: 'http://127.0.0.1:8787/v1',
          model: 'custom-ccb-route',
          routeId: 'omniroute/ccb-chat',
          receiptPolicy: 'omniroute',
          headers: expect.objectContaining({ 'X-OmniRoute-Client': 'ccb' }),
          kind: 'provider',
        }),
      ])
    } finally {
      restoreRouteEnv(previous)
    }
  })

  it('sends identity metadata without selecting project or Context provider', () => {
    expect(
      buildOmniRouteRequestHeaders({
        workspace: '/work/ccb\nignored',
        gitRemote: 'https://token:secret@example.test/org/ccb.git?key=value',
        gitRevision: 'A'.repeat(40),
        repo: 'ccb',
        mission: 'modify CCB source',
        sessionId: 'session-1',
      }),
    ).toEqual({
      'X-OmniRoute-Client': 'ccb',
      'X-OmniRoute-Workspace': 'uri:%2Fwork%2Fccb%20ignored',
      'X-OmniRoute-Git-Remote': 'https://example.test/org/ccb.git',
      'X-OmniRoute-Git-Revision': 'a'.repeat(40),
      'X-OmniRoute-Repo': 'ccb',
      'X-OmniRoute-Mission': 'uri:modify%20CCB%20source',
      'X-OmniRoute-Session-Id': 'session-1',
    })
  })

  it('omits malformed Git revisions', () => {
    const headers = buildOmniRouteRequestHeaders({
      gitRevision: 'a'.repeat(39) + '\nX-Injected: value',
    })
    expect(headers).not.toHaveProperty('X-OmniRoute-Git-Revision')
  })

  it('encodes Unicode mission metadata as an ASCII-safe header', () => {
    expect(
      buildOmniRouteRequestHeaders({ mission: '无人值守 自修复' }),
    ).toHaveProperty(
      'X-OmniRoute-Mission',
      `uri:${encodeURIComponent('无人值守 自修复')}`,
    )
  })

  it('encodes Unicode workspace metadata as an ASCII-safe header', () => {
    expect(
      buildOmniRouteRequestHeaders({ workspace: '/home/melody/文档' }),
    ).toHaveProperty(
      'X-OmniRoute-Workspace',
      'uri:%2Fhome%2Fmelody%2F%E6%96%87%E6%A1%A3',
    )
  })

  it('maps CCB aliases to their current OmniRoute route labels', () => {
    const previous = {
      CCB_HEADROOM_BASE_URL: process.env.CCB_HEADROOM_BASE_URL,
      CCB_ROUTE_NAME: process.env.CCB_ROUTE_NAME,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
    }
    delete process.env.CCB_HEADROOM_BASE_URL
    delete process.env.CCB_ROUTE_NAME
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      for (const [model, routeModel] of [
        ['auto', 'ccb-main'],
        ['race', 'ccb-main'],
        ['auto/fast', 'ccb-chat'],
        ['ccb/auto', 'ccb-main'],
      ]) {
        const routes = resolveDirectRoutes(model)
        expect(routes).toEqual([
          expect.objectContaining({
            providerId: 'omniroute',
            baseURL: 'http://127.0.0.1:20128/v1',
            model: routeModel,
            routeId: 'omniroute/ccb-chat',
            receiptPolicy: 'omniroute',
            kind: 'provider',
          }),
        ])
      }
      expect(resolveDirectRoutes('hermes-score')).toEqual([])
    } finally {
      restoreRouteEnv(previous)
    }
  })

  it('resolves CCB, gateway 9router, and direct 9router routes', () => {
    const previous = {
      CCB_HEADROOM_BASE_URL: process.env.CCB_HEADROOM_BASE_URL,
      OMNIRUTE_URL: process.env.OMNIRUTE_URL,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
      OMNIROUTE_9ROUTER_MODEL: process.env.OMNIROUTE_9ROUTER_MODEL,
      NINEROUTER_BASE_URL: process.env.NINEROUTER_BASE_URL,
      NINEROUTER_MODEL: process.env.NINEROUTER_MODEL,
      NINEROUTER_API_KEY: process.env.NINEROUTER_API_KEY,
    }
    delete process.env.CCB_HEADROOM_BASE_URL
    delete process.env.OMNIRUTE_URL
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    process.env.OMNIROUTE_9ROUTER_MODEL = '9router/primary/sonnet'
    process.env.NINEROUTER_BASE_URL = 'http://127.0.0.1:20130/v1'
    process.env.NINEROUTER_MODEL = 'direct-model'
    process.env.NINEROUTER_API_KEY = 'direct-key'
    resetOmniRouteConfig()
    try {
      expect(resolveDirectRoutes('ccb-main')[0]).toMatchObject({
        providerId: 'omniroute',
        baseURL: 'http://127.0.0.1:20128/v1',
        model: 'ccb-main',
        routeId: 'omniroute/ccb-chat',
        receiptPolicy: 'omniroute',
      })
      const gateway9RouterRoute = resolveDirectRoutes('omniroute/9router')[0]
      expect(gateway9RouterRoute).toMatchObject({
        providerId: 'omniroute-9router',
        baseURL: 'http://127.0.0.1:20128/v1',
        model: '9router/primary/sonnet',
        routeId: 'omniroute/9router',
        receiptPolicy: 'omniroute-9router',
      })
      expect(gateway9RouterRoute.headers).toHaveProperty(
        'X-OmniRoute-Client',
        'ccb',
      )
      const directRoute = resolveDirectRoutes('9router/direct')[0]
      expect(directRoute).toMatchObject({
        providerId: '9router',
        baseURL: 'http://127.0.0.1:20130/v1',
        model: 'direct-model',
        apiKey: 'direct-key',
        routeId: '9router/direct',
        receiptPolicy: 'none',
      })
      expect(directRoute.headers).toBeUndefined()
    } finally {
      restoreRouteEnv(previous)
    }
  })

  it('fails closed for invalid route-specific configuration', () => {
    const previous = {
      CCB_HEADROOM_BASE_URL: process.env.CCB_HEADROOM_BASE_URL,
      OMNIRUTE_URL: process.env.OMNIRUTE_URL,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
      OMNIROUTE_9ROUTER_MODEL: process.env.OMNIROUTE_9ROUTER_MODEL,
      NINEROUTER_BASE_URL: process.env.NINEROUTER_BASE_URL,
      NINEROUTER_MODEL: process.env.NINEROUTER_MODEL,
      NINEROUTER_API_KEY: process.env.NINEROUTER_API_KEY,
    }
    delete process.env.CCB_HEADROOM_BASE_URL
    delete process.env.OMNIRUTE_URL
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    delete process.env.OMNIROUTE_9ROUTER_MODEL
    delete process.env.NINEROUTER_BASE_URL
    delete process.env.NINEROUTER_MODEL
    delete process.env.NINEROUTER_API_KEY
    resetOmniRouteConfig()
    try {
      expect(() => resolveDirectRoutes('omniroute/9router')).toThrow(
        'OMNIROUTE_9ROUTER_MODEL',
      )
      expect(() => resolveDirectRoutes('9router/direct')).toThrow(
        'NINEROUTER_BASE_URL',
      )
      process.env.OMNIROUTE_9ROUTER_MODEL = 'invalid'
      expect(() => resolveDirectRoutes('omniroute/9router')).toThrow(
        'omniroute/9router',
      )
      process.env.NINEROUTER_BASE_URL = 'http://127.0.0.1:20128/v1/'
      process.env.NINEROUTER_MODEL = 'direct-model'
      process.env.NINEROUTER_API_KEY = 'direct-key'
      expect(() => resolveDirectRoutes('9router/direct')).toThrow(
        'differ from the OmniRoute ingress',
      )
    } finally {
      restoreRouteEnv(previous)
    }
  })

  it('does not fall back from a route-specific configuration failure', () => {
    const previous = {
      CCB_HEADROOM_BASE_URL: process.env.CCB_HEADROOM_BASE_URL,
      OMNIRUTE_URL: process.env.OMNIRUTE_URL,
      OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
      OMNIROUTE_9ROUTER_MODEL: process.env.OMNIROUTE_9ROUTER_MODEL,
    }
    delete process.env.CCB_HEADROOM_BASE_URL
    delete process.env.OMNIRUTE_URL
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    delete process.env.OMNIROUTE_9ROUTER_MODEL
    resetOmniRouteConfig()
    try {
      expect(() => resolveDirectRoutes('omniroute/9router')).toThrow()
    } finally {
      restoreRouteEnv(previous)
    }
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
        'X-OmniRoute-Cognitive-Task': 'execution',
        'X-OmniRoute-Cognitive-Pool': 'executor',
        'X-OmniRoute-Cognitive-Context': 'codebase',
        'X-OmniRoute-Cognitive-Effort': 'high',
        'X-OmniRoute-Cache': 'HIT',
        'X-OmniRoute-Cache-Hit': 'true',
        'X-OmniRoute-Context-Project': 'Home-melody-ccb-source',
        'X-OmniRoute-Context-Project-Source': 'workspace',
        'X-OmniRoute-Context-Sources': 'codebase-memory',
        'X-OmniRoute-Context-Cache': 'hit',
        'X-OmniRoute-Context-Bundle': 'context receipt',
        'X-OmniRoute-Context-Tokens': '4321',
        'X-OmniRoute-Context-Fingerprint': 'context-fingerprint',
        'X-OmniRoute-Context-Cache-Hit': 'true',
        'X-OmniRoute-Routing-Reason': 'coding task',
        'X-OmniRoute-Cache-Debug': JSON.stringify({
          client: 'ccb',
          routePool: 'worker',
          sessionId: 'session-fingerprint',
          conversationFingerprint: 'conversation-fingerprint',
          contextHash: 'context-hash',
          cacheKey: 'cache-key',
          missReason: null,
        }),
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
      cognitiveTask: 'execution',
      cognitivePool: 'executor',
      cognitiveContext: 'codebase',
      cognitiveEffort: 'high',
      cache: 'HIT',
      cacheHit: true,
      contextProject: 'Home-melody-ccb-source',
      contextProjectSource: 'workspace',
      contextSources: 'codebase-memory',
      contextCache: 'hit',
      contextBundle: 'context receipt',
      contextTokens: 4321,
      contextFingerprint: 'context-fingerprint',
      contextCacheHit: true,
      routingReason: 'coding task',
      cacheDebug: {
        client: 'ccb',
        routePool: 'worker',
        sessionId: 'session-fingerprint',
        conversationFingerprint: 'conversation-fingerprint',
        contextHash: 'context-hash',
        cacheKey: 'cache-key',
        missReason: null,
      },
    })
    expect(getLastOmniRouteReceipt()).toEqual(receipt)
    expect(getActiveCcbRoute()).toEqual({
      provider: 'glm',
      model: 'z-ai/glm-5.2',
    })
  })

  it('keeps an explicit active route when a receipt omits provider metadata', () => {
    setActiveCcbRoute('cx', 'gpt-5.6-terra')
    parseOmniRouteReceipt(
      new Headers({ 'X-OmniRoute-Request-Id': 'req-without-route' }),
    )
    expect(getActiveCcbRoute()).toEqual({
      provider: 'cx',
      model: 'gpt-5.6-terra',
    })
  })

  it('ignores malformed cache-debug metadata', () => {
    expect(
      parseOmniRouteReceipt(
        new Headers({ 'X-OmniRoute-Cache-Debug': '{not json}' }),
      ),
    ).toBeNull()
  })
})

describe('explicit provider route resolution', () => {
  const previous = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    OMNIROUTE_BASE_URL: process.env.OMNIROUTE_BASE_URL,
    OPENCODE_ZEN_BASE_URL: process.env.OPENCODE_ZEN_BASE_URL,
  }
  let tmpDir = ''

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'adapter-providers-'))
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    _invalidateProviderCache()
    resetOmniRouteConfig()
  })

  function writeProviders(providers: ProviderConfig[]): void {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      `${JSON.stringify(providers)}\n`,
      {
        mode: 0o600,
      },
    )
    _invalidateProviderCache()
  }

  function providerWithDefaults(
    overrides: Partial<ProviderConfig>,
  ): ProviderConfig {
    return {
      id: 'test-provider',
      kind: 'openai-compat',
      baseUrl: 'https://provider.example.test/v1',
      defaultModel: 'default-model',
      compatRule: 'permissive',
      ...overrides,
    }
  }

  function restoreExplicitEnv(): void {
    if (previous.CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous.CLAUDE_CONFIG_DIR
    }
    if (previous.OMNIROUTE_BASE_URL === undefined) {
      delete process.env.OMNIROUTE_BASE_URL
    } else {
      process.env.OMNIROUTE_BASE_URL = previous.OMNIROUTE_BASE_URL
    }
    if (previous.OPENCODE_ZEN_BASE_URL === undefined) {
      delete process.env.OPENCODE_ZEN_BASE_URL
    } else {
      process.env.OPENCODE_ZEN_BASE_URL = previous.OPENCODE_ZEN_BASE_URL
    }
    _invalidateProviderCache()
    resetOmniRouteConfig()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = ''
  }

  it('resolves opencode/<model> directly, bypassing OmniRoute', () => {
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    process.env.OPENCODE_ZEN_BASE_URL = 'https://zen.example.test/v1'
    resetOmniRouteConfig()
    try {
      const routes = resolveDirectRoutes('opencode/claude-3-7-sonnet')
      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({
        providerId: 'opencode',
        baseURL: 'https://zen.example.test/v1',
        model: 'claude-3-7-sonnet',
        apiKey: 'public',
        headers: {
          'x-opencode-client': 'desktop',
          Accept: 'text/event-stream',
        },
        receiptPolicy: 'none',
        kind: 'opencode',
      })
    } finally {
      delete process.env.OPENCODE_ZEN_BASE_URL
      restoreExplicitEnv()
    }
  })

  it('uses the OpenCode Zen default base URL when unset', () => {
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const route = resolveDirectRoutes('opencode/some-model')[0]
      expect(route?.baseURL).toBe('https://opencode.ai/zen/v1')
      expect(route?.model).toBe('some-model')
    } finally {
      restoreExplicitEnv()
    }
  })

  it('expands multiple provider accounts into independent routes', () => {
    writeProviders([
      providerWithDefaults({
        accounts: [
          { id: 'acc-1', apiKey: 'key-1' },
          { id: 'acc-2', apiKey: 'key-2' },
        ],
      }),
    ])
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const routes = resolveDirectRoutes('test-provider/model-x')
      expect(routes).toHaveLength(2)
      expect(routes[0]).toMatchObject({
        providerId: 'test-provider',
        baseURL: 'https://provider.example.test/v1',
        model: 'model-x',
        apiKey: 'key-1',
        accountId: 'acc-1',
        receiptPolicy: 'none',
        kind: 'provider',
      })
      expect(routes[1]).toMatchObject({
        model: 'model-x',
        apiKey: 'key-2',
        accountId: 'acc-2',
      })
      expect(routes[0].apiKey).not.toBe(routes[1].apiKey)
    } finally {
      restoreExplicitEnv()
    }
  })

  it('skips disabled and credential-less accounts', () => {
    writeProviders([
      providerWithDefaults({
        accounts: [
          { id: 'enabled', apiKey: 'key-ok', enabled: true },
          { id: 'disabled', apiKey: 'key-off', enabled: false },
          { id: 'no-key', apiKeyEnv: 'TEST_MISSING_ENV' },
        ],
      }),
    ])
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const routes = resolveDirectRoutes('test-provider/model-x')
      expect(routes).toHaveLength(1)
      expect(routes[0]).toMatchObject({
        accountId: 'enabled',
        apiKey: 'key-ok',
      })
    } finally {
      restoreExplicitEnv()
    }
  })

  it('honors the account-level model override', () => {
    writeProviders([
      providerWithDefaults({
        accounts: [{ id: 'acc-1', apiKey: 'key-1', model: 'fixed-model' }],
      }),
    ])
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const routes = resolveDirectRoutes('test-provider/model-x')
      expect(routes).toHaveLength(1)
      expect(routes[0]?.model).toBe('fixed-model')
    } finally {
      restoreExplicitEnv()
    }
  })

  it('falls back to the provider-level key', () => {
    writeProviders([
      providerWithDefaults({
        apiKey: 'provider-key',
        accounts: [
          { id: 'acc-1', apiKey: '  ' },
          { id: 'acc-2', apiKeyEnv: 'TEST_ACCOUNT_ENV' },
        ],
      }),
    ])
    process.env.TEST_ACCOUNT_ENV = 'env-account-key'
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const routes = resolveDirectRoutes('test-provider/model-x')
      expect(routes).toHaveLength(2)
      expect(routes[0]?.apiKey).toBe('provider-key')
      expect(routes[1]?.apiKey).toBe('env-account-key')
    } finally {
      delete process.env.TEST_ACCOUNT_ENV
      restoreExplicitEnv()
    }
  })

  it('propagates headers, timeoutMs, and compatRule from the provider', () => {
    writeProviders([
      providerWithDefaults({
        accounts: [{ id: 'acc-1', apiKey: 'key-1' }],
        headers: { 'X-Custom': 'value' },
        timeoutMs: 42_000,
        compatRule: 'deepseek',
      }),
    ])
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      const route = resolveDirectRoutes('test-provider/model-x')[0]
      expect(route).toMatchObject({
        headers: { 'X-Custom': 'value' },
        timeoutMs: 42_000,
        compatRule: 'deepseek',
      })
    } finally {
      restoreExplicitEnv()
    }
  })

  it('fails closed for gitee: no generation route at all', () => {
    writeProviders([
      providerWithDefaults({
        id: 'gitee',
        baseUrl: 'https://gitee.example.test/v1',
        apiKey: 'gitee-key',
      }),
    ])
    expect(chooseAccounts(providerWithDefaults({ id: 'GITEE' }))).toEqual([])
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    resetOmniRouteConfig()
    try {
      expect(resolveDirectRoutes('gitee/model-x')).toEqual([])
    } finally {
      restoreExplicitEnv()
    }
  })

  it('preserves the stable omniroute/9router and 9router/direct routes', () => {
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    process.env.OMNIROUTE_9ROUTER_MODEL = '9router/primary/sonnet'
    process.env.NINEROUTER_BASE_URL = 'http://127.0.0.1:20130/v1'
    process.env.NINEROUTER_MODEL = 'direct-model'
    process.env.NINEROUTER_API_KEY = 'direct-key'
    resetOmniRouteConfig()
    try {
      expect(resolveDirectRoutes('omniroute/9router')[0]).toMatchObject({
        routeId: 'omniroute/9router',
        receiptPolicy: 'omniroute-9router',
      })
      expect(resolveDirectRoutes('9router/direct')[0]).toMatchObject({
        routeId: '9router/direct',
        receiptPolicy: 'none',
      })
    } finally {
      restoreExplicitEnv()
    }
  })
})
