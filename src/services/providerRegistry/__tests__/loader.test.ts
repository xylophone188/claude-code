import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { logMock } from '../../../../tests/mocks/log.js'

// Must mock log before any import that transitively loads log.ts
mock.module('src/utils/log.ts', logMock)

// bun:bundle must be mocked before imports that use feature()
mock.module('bun:bundle', () => ({ feature: () => false }))

// settings.js must be mocked to cut bootstrap chain
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

let tmpDir: string

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'provider-loader-test-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  // J1 fix: clear the per-process cache BEFORE this test runs — an earlier test
  // file (e.g. directRouter) may have cached providers read from the real
  // CLAUDE_CONFIG_DIR, so loadProviders() would return stale external entries.
  const { _invalidateProviderCache } = await import('../loader.js')
  _invalidateProviderCache()
})

afterEach(async () => {
  delete process.env['CLAUDE_CONFIG_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
  // J1 fix: invalidate the per-process cache between tests so each test starts fresh
  const { _invalidateProviderCache } = await import('../loader.js')
  _invalidateProviderCache()
})

describe('loadProviders', () => {
  test('loads usable CCB embed provider credentials without exposing them', async () => {
    const embedFile = join(tmpDir, 'ccb-providers.json')
    process.env.CCB_EMBED_PROVIDERS_FILE = embedFile
    writeFileSync(
      embedFile,
      JSON.stringify({
        providers: [
          {
            id: 'sensenova',
            baseUrl: 'https://token.sensenova.cn/v1',
            autoModel: 'sensenova-6.8-flash-lite',
            autoModels: ['glm-5.2'],
            keys: ['secret-one'],
          },
        ],
      }),
    )
    const { loadCcbEmbedProviders } = await import('../loader.js')
    const provider = loadCcbEmbedProviders()[0]
    expect(provider).toMatchObject({
      id: 'sensenova',
      defaultModel: 'sensenova-6.8-flash-lite',
      models: ['sensenova-6.8-flash-lite', 'glm-5.2'],
    })
    expect(provider?.accounts?.[0]?.apiKey).toBe('secret-one')
    delete process.env.CCB_EMBED_PROVIDERS_FILE
  })

  test('returns built-in providers (core + Embedded) when providers.json does not exist', async () => {
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    const expectedIds = new Set(BUILTIN_PROVIDERS.map(p => p.id))
    const receivedIds = new Set(providers.map(p => p.id))
    // Same id set, deduplicated (core default beats Embedded on overlap)
    expect(receivedIds).toEqual(expectedIds)
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
  })

  test('returns defaults when providers.json is empty', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '')
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
  })

  test('returns defaults when providers.json is empty array', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '[]')
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
  })

  test('returns defaults when providers.json is corrupt JSON', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '{not valid json')
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
  })

  test('returns defaults when providers.json fails schema validation', async () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify([{ id: 123, kind: 'bad-kind', baseUrl: 'not-a-url' }]),
    )
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
  })

  test('merges valid user providers on top of defaults', async () => {
    const customProvider = {
      id: 'myendpoint',
      kind: 'openai-compat',
      baseUrl: 'https://my.api.com/v1',
      apiKeyEnv: 'MY_API_KEY',
      defaultModel: 'my-model',
      compatRule: 'permissive',
    }
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify([customProvider]),
    )
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    // builtins + 1 custom
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length + 1)
    expect(providers.find(p => p.id === 'myendpoint')).toMatchObject({
      baseUrl: 'https://my.api.com/v1',
    })
  })

  test('user provider with same id as default replaces the default', async () => {
    const overrideCerebras = {
      id: 'cerebras',
      kind: 'openai-compat',
      baseUrl: 'https://custom-cerebras.example.com/v1',
      apiKeyEnv: 'CEREBRAS_API_KEY',
      defaultModel: 'gpt-oss-120b',
      compatRule: 'cerebras',
    }
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify([overrideCerebras]),
    )
    const { loadProviders, BUILTIN_PROVIDERS } = await import('../loader.js')
    const providers = loadProviders()
    // Same count (cerebras replaced, not added)
    expect(providers).toHaveLength(BUILTIN_PROVIDERS.length)
    const cerebras = providers.find(p => p.id === 'cerebras')
    expect(cerebras?.baseUrl).toBe('https://custom-cerebras.example.com/v1')
  })

  test('findProvider returns undefined for unknown id', async () => {
    const { findProvider, DEFAULT_PROVIDERS } = await import('../loader.js')
    const result = findProvider('nonexistent', DEFAULT_PROVIDERS)
    expect(result).toBeUndefined()
  })

  test('findProvider returns correct provider for known id', async () => {
    const { findProvider, DEFAULT_PROVIDERS } = await import('../loader.js')
    const deepseek = findProvider('deepseek', DEFAULT_PROVIDERS)
    expect(deepseek?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(deepseek?.compatRule).toBe('deepseek')
  })
})
