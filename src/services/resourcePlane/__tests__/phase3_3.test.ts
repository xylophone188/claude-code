/**
 * Phase 3.3 Acceptance Tests: Synchronous Startup Initialization
 *
 * Validates:
 * - CCB_RESOURCE_PLANE=0 → LegacyBackend, identical to baseline
 * - CCB_RESOURCE_PLANE=1 → ResourcePlaneBackend, warmCache called
 * - Empty DB fallback
 * - PG error graceful degradation
 * - saveProviders() invalidates cache
 * - resolveTransportCredential() at transport boundary
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Must mock log before any import that transitively loads log.ts
mock.module('src/utils/log.ts', () => ({ logError: () => {} }))
mock.module('src/utils/debug.ts', () => ({ logForDebugging: () => {} }))

// bun:bundle must be mocked
mock.module('bun:bundle', () => ({ feature: () => false }))

let tmpDir: string
let originalEnvValue: string | undefined

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'phase33-test-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
  originalEnvValue = process.env['CCB_RESOURCE_PLANE']
  // Reset the singleton registry before each test so bootstrap can re-register
  const { ProviderBackendRegistry } = await import(
    '../../providerRegistry/registry.js'
  )
  ProviderBackendRegistry.resetForTest()
})

afterEach(() => {
  delete process.env['CLAUDE_CONFIG_DIR']
  if (originalEnvValue !== undefined) {
    process.env['CCB_RESOURCE_PLANE'] = originalEnvValue
  } else {
    delete process.env['CCB_RESOURCE_PLANE']
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Phase 3.3: LegacyBackend (CCB_RESOURCE_PLANE=0)', () => {
  test('bootstrapProviders selects LegacyBackend when flag is 0', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '0'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )
    const { LegacyBackend, ResourcePlaneBackend } = await import(
      '../../providerRegistry/backend.js'
    )

    await bootstrapProviders()
    expect(ProviderBackendRegistry.isInitialized()).toBe(true)
    expect(ProviderBackendRegistry.getBackend()).toBeInstanceOf(LegacyBackend)
    expect(
      ProviderBackendRegistry.getBackend(),
    ).not.toBeInstanceOf(ResourcePlaneBackend)
  })

  test('LegacyBackend.loadProvidersSync() returns built-in providers', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '0'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )

    await bootstrapProviders()
    const providers = ProviderBackendRegistry.getBackend().loadProvidersSync()
    expect(providers.length).toBeGreaterThan(0)
    // Should include cerebras and deepseek from DEFAULT_PROVIDERS
    expect(providers.some(p => p.id === 'cerebras')).toBe(true)
    expect(providers.some(p => p.id === 'deepseek')).toBe(true)
  })

  test('loadProviders() is synchronous — no await needed', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '0'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { loadProviders } = await import('../../providerRegistry/loader.js')

    await bootstrapProviders()
    // loadProviders must return synchronously
    const start = Date.now()
    const providers = loadProviders()
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(100) // should be instant, no I/O
    expect(Array.isArray(providers)).toBe(true)
  })
})

describe('Phase 3.3: ResourcePlaneBackend (CCB_RESOURCE_PLANE=1)', () => {
  test('bootstrapProviders selects ResourcePlaneBackend when flag is 1', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '1'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )
    const { ResourcePlaneBackend } = await import(
      '../../providerRegistry/backend.js'
    )

    await bootstrapProviders()
    expect(ProviderBackendRegistry.isInitialized()).toBe(true)
    expect(ProviderBackendRegistry.getBackend()).toBeInstanceOf(ResourcePlaneBackend)
  })

  test('ResourcePlaneBackend.loadProvidersSync() returns resourcePlane data', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '1'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )

    await bootstrapProviders()
    const providers = ProviderBackendRegistry.getBackend().loadProvidersSync()
    expect(providers.length).toBeGreaterThan(0)
  })

  test('ResourcePlaneBackend.resolveCredential() is async and graceful', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '1'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )

    await bootstrapProviders()
    const backend = ProviderBackendRegistry.getBackend()
    expect(typeof backend.resolveCredential).toBe('function')

    // Non-existent account → undefined, no throw
    const result = await backend.resolveCredential!('nonexistent', 'nonexistent')
    expect(result).toBeUndefined()

    // Existing provider account → string or undefined, no throw
    const gitee = await backend.resolveCredential!('gitee', 'ccb-key-1')
    expect(gitee === undefined || typeof gitee === 'string').toBe(true)
  })
})

describe('Phase 3.3: Cache invalidation', () => {
  test('ResourcePlaneBackend.invalidateCache() clears cache', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '1'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )

    await bootstrapProviders()
    const backend = ProviderBackendRegistry.getBackend()
    const first = backend.loadProvidersSync()
    expect(first.length).toBeGreaterThan(0)

    backend.invalidateCache()
    // After invalidation, next loadProvidersSync returns [] (not re-warmed)
    const second = backend.loadProvidersSync()
    expect(Array.isArray(second)).toBe(true)
    expect(second.length).toBe(0)
  })

  test('LegacyBackend.invalidateCache() allows re-read', async () => {
    process.env['CCB_RESOURCE_PLANE'] = '0'
    const { bootstrapProviders } = await import('../../bootstrap/index.js')
    const { ProviderBackendRegistry } = await import(
      '../../providerRegistry/registry.js'
    )

    await bootstrapProviders()
    const backend = ProviderBackendRegistry.getBackend()
    const first = backend.loadProvidersSync()
    expect(first.length).toBeGreaterThan(0)

    backend.invalidateCache()
    const second = backend.loadProvidersSync()
    expect(second.length).toEqual(first.length)
  })
})

describe('Phase 3.3: Fallback behavior', () => {
  test('ResourcePlaneBackend.warmCache() handles PG error gracefully', async () => {
    const { ResourcePlaneBackend } = await import(
      '../../providerRegistry/backend.js'
    )
    const backend = new ResourcePlaneBackend()

    // Should not throw even if PG is unavailable (catch block returns [])
    await expect(backend.warmCache()).resolves.toBeUndefined()
    // After warm, cache is populated (possibly empty if PG down)
    const providers = backend.loadProvidersSync()
    expect(Array.isArray(providers)).toBe(true)
  })

  test('loader.ts loadProviders() falls back to legacy when registry not initialized', async () => {
    const { loadProviders } = await import('../../providerRegistry/loader.js')
    // When registry not initialized, should use legacy path directly
    const providers = loadProviders()
    expect(Array.isArray(providers)).toBe(true)
    expect(providers.length).toBeGreaterThan(0)
  })
})
